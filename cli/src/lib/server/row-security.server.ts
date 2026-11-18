/**
 * Per-viewer row security for `evidence serve`, configured per page with an
 * `auth.rows` frontmatter block:
 *
 *   auth:
 *     rows:
 *       students: school_id in (select school_id from staff where email = {{ $user.email }})
 *
 * Self-host only; a local extension beyond upstream Evidence.
 *
 * - Page access: a viewer for whom every filtered table on the page comes
 *   back empty gets a 403 (with `auth.message`), on the page and on its
 *   queries alike.
 * - Queries: every `/api/query` request names its page. The server parses the
 *   SQL with DuckDB and swaps each reference to a filtered table for
 *   `(SELECT * FROM table WHERE <predicate>)` before running it. A table that
 *   any page filters is *protected*: a query reading it from a page without
 *   its own filter for it is refused, so naming a different page can't get
 *   around the filter.
 * - Declared tables: once any page has row filters, a query may only read
 *   tables its page declares, in `auth.tables` or as a key of its own
 *   `auth.rows`. Every other table is refused, on every page.
 *
 * DuckDB / MotherDuck connections only (the rewrite uses DuckDB's parser);
 * hooks.server.ts refuses to start otherwise.
 */

import { error, isHttpError } from '@sveltejs/kit';
import {
	discoverMarkdownFiles,
	getHomeFile,
	getMarkdownFile,
	parsePageAuth,
	type MarkdownFile
} from '$lib/markdown/files.server';
import { getProjectCwd } from './project-cwd';
import { getProxyUser, type ProxyUser } from './proxy-auth.server';
import { runQuery } from './run-query';
import {
	deserialize,
	filterTemplate,
	filteredRef,
	inspect,
	keyTableName,
	parseSelect,
	rewriteTables,
	sqlString,
	tableMatches,
	type JsonNode
} from './row-filter-sql';

export type QueryAuthzResult = { ok: true; sql: string } | { ok: false; status: number; error: string };

export function plainHeaderTrusted(): boolean {
	return process.env.EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER === 'true';
}

export function identityMode(): 'jwt' | 'header' | 'none' {
	if (process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL) return 'jwt';
	if (process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER) return 'header';
	return 'none';
}

const ACCESS_CACHE_TTL_MS = 60_000;

/**
 * Table functions that read a relation or file by *name*, so they'd reach a
 * protected table's rows without a table reference to rewrite. Refused in
 * every query once any page has row filters.
 */
const BLOCKED_FUNCTIONS: ReadonlySet<string> = new Set(['query', 'query_table', 'sniff_csv']);
const BLOCKED_FUNCTION_PATTERNS = [/^read_/, /_scan$/, /^parquet_/, /^iceberg_/, /^delta_/];

function isBlockedFunction(name: string): boolean {
	return BLOCKED_FUNCTIONS.has(name) || BLOCKED_FUNCTION_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Policies (serve mode content is immutable; cached for the process)
// ---------------------------------------------------------------------------

export interface PagePolicy {
	slug: string;
	rows: Record<string, string>;
	message?: string;
}

function policyOf(file: MarkdownFile): PagePolicy | null {
	const auth = parsePageAuth(file.content);
	const rows = Object.fromEntries(
		Object.entries(auth?.rows ?? {}).filter(([table, predicate]) => table.trim() && predicate.trim())
	);
	if (!Object.keys(rows).length) return null;
	return { slug: file.slug, rows, message: auth?.message };
}

/**
 * The tables a page's queries may read once row security is on: its
 * `auth.tables` plus the keys of its own `auth.rows`.
 */
export function declaredTables(file: MarkdownFile): string[] {
	const auth = parsePageAuth(file.content);
	return [...(auth?.tables ?? []), ...Object.keys(auth?.rows ?? {})]
		.map((table) => table.trim())
		.filter(Boolean);
}

let policiesCache: Promise<PagePolicy[]> | null = null;
const accessCache = new Map<string, { allowed: boolean; expiresAt: number }>();

/** Every page with an `auth.rows` block. */
export function pagesWithRowFilters(cwd: string = getProjectCwd()): Promise<PagePolicy[]> {
	return (policiesCache ??= discoverMarkdownFiles(cwd).then((files) =>
		files.map(policyOf).filter((p): p is PagePolicy => p !== null)
	));
}

/** Pages still using the removed `auth.users` / `auth.query` allowlist. */
export async function pagesWithLegacyAuth(cwd: string = getProjectCwd()): Promise<string[]> {
	const files = await discoverMarkdownFiles(cwd);
	return files
		.filter((file) => {
			const auth = parsePageAuth(file.content);
			return !!auth && ('users' in auth || 'query' in auth);
		})
		.map((file) => file.slug);
}

/** Test hook: forget everything cached per process. */
export function resetRowSecurityCaches(): void {
	policiesCache = null;
	accessCache.clear();
}

// ---------------------------------------------------------------------------
// Viewer substitution
// ---------------------------------------------------------------------------

/**
 * Replaces `{{ $user.email }}` (and `first_name` / `last_name`) in a predicate
 * with the viewer's value as a quoted SQL literal. Surrounding single quotes
 * are absorbed, so `'{{ $user.email }}'` works the same as the bare form.
 */
export function substituteViewer(predicate: string, viewer: ProxyUser): string {
	return predicate.replace(/'?\{\{\s*\$user\.(\w+)\s*\}\}'?/g, (_match, field: string) => {
		switch (field) {
			case 'email':
				return sqlString(viewer.email);
			case 'first_name':
				return viewer.firstName ? sqlString(viewer.firstName) : 'NULL';
			case 'last_name':
				return 'NULL';
			default:
				throw new Error(`Unknown variable $user.${field} in auth.rows`);
		}
	});
}

function combinedPredicate(predicates: string[], viewer: ProxyUser): string {
	return predicates.map((p) => `(${substituteViewer(p, viewer)})`).join(' AND ');
}

// ---------------------------------------------------------------------------
// Page access
// ---------------------------------------------------------------------------

function quoteIdent(part: string): string {
	return `"${part.replace(/"/g, '""')}"`;
}

function keyParts(key: string): string[] {
	return key.split('.').map((part) => part.trim().replace(/^"(.*)"$/, '$1'));
}

/**
 * The fully qualified tables and views an `auth.rows` key covers, newest
 * schema first. A key with fewer than three parts covers every match in every
 * attached catalog (see tableMatches), and usually doesn't resolve on its own
 * when the table lives in an attached database, so it's looked up in DuckDB's
 * catalog. Falls back to the key as written when nothing matches, so DuckDB's
 * own "does not exist" error comes through.
 */
async function accessCheckTargets(key: string): Promise<string[]> {
	const parts = keyParts(key);
	if (parts.length >= 3) return [key];
	const [table, schema] = [...parts].reverse();
	const where = (nameColumn: string) =>
		[
			'NOT internal',
			`lower(${nameColumn}) = lower(${sqlString(table ?? '')})`,
			...(schema ? [`lower(schema_name) = lower(${sqlString(schema)})`] : [])
		].join(' AND ');
	const result = await runQuery(
		'SELECT database_name AS c, schema_name AS s, name AS t FROM (' +
			`SELECT database_name, schema_name, table_name AS name FROM duckdb_tables() WHERE ${where('table_name')} UNION ALL ` +
			`SELECT database_name, schema_name, view_name AS name FROM duckdb_views() WHERE ${where('view_name')}` +
			') ORDER BY s DESC, c'
	);
	if (result.error || !result.rows.length) return [key];
	return result.rows.map((row) => [row.c, row.s, row.t].map((p) => quoteIdent(String(p))).join('.'));
}

/**
 * Whether `predicate` keeps any row of the table(s) `key` covers. Every
 * candidate is tried in one query first; if that fails (say an older schema
 * lacks a column the predicate uses), one at a time, newest first. Errors
 * only when every candidate does.
 */
async function anyRowMatches(key: string, where: string): Promise<boolean> {
	const targets = await accessCheckTargets(key);
	const probe = (target: string) => `SELECT 1 AS ok FROM ${target} WHERE ${where} LIMIT 1`;

	if (targets.length > 1) {
		const union = await runQuery(
			`SELECT 1 AS ok FROM (${targets.map((t) => `(${probe(t)})`).join(' UNION ALL ')}) LIMIT 1`
		);
		if (!union.error) return union.rows.length > 0;
	}

	const errors: string[] = [];
	for (const target of targets) {
		const result = await runQuery(probe(target));
		if (result.error) errors.push(result.error);
		else if (result.rows.length > 0) return true;
	}
	if (errors.length === targets.length) {
		error(500, `auth.rows filter for ${key} failed: ${errors[0]}`);
	}
	return false;
}

async function viewerHasRows(policy: PagePolicy, viewer: ProxyUser): Promise<boolean> {
	const key = `${policy.slug}\0${viewer.email.toLowerCase()}`;
	const cached = accessCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.allowed;

	let allowed = false;
	for (const [table, predicate] of Object.entries(policy.rows)) {
		let where: string;
		try {
			where = combinedPredicate([predicate], viewer);
		} catch (e) {
			error(500, (e as Error).message);
		}
		if (await anyRowMatches(table, where)) {
			allowed = true;
			break;
		}
	}

	accessCache.set(key, { allowed, expiresAt: Date.now() + ACCESS_CACHE_TTL_MS });
	return allowed;
}

/**
 * Throws a SvelteKit 403 if `file` has row filters and the viewer either has
 * no proxy identity or gets no rows from any of them. Returns the viewer
 * (null when the page has no filters). Rendered by `routes/+error.svelte`.
 */
async function checkPageAccess(file: MarkdownFile, headers: Headers): Promise<ProxyUser | null> {
	const policy = policyOf(file);
	if (!policy) return null;

	const viewer = await getProxyUser(headers);
	if (!viewer) error(403, 'This page requires an authenticated viewer identity.');

	if (!(await viewerHasRows(policy, viewer))) {
		const message = policy.message
			? policy.message.replaceAll('{email}', viewer.email)
			: `${viewer.email} does not have access to this page.`;
		error(403, message);
	}
	return viewer;
}

/** Page-loader entry point; see checkPageAccess. */
export async function assertPageAccess(file: MarkdownFile, headers: Headers): Promise<void> {
	await checkPageAccess(file, headers);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const NOT_PERMITTED = 'Query not permitted on this page.';

/**
 * Authorizes a serve-mode `/api/query` request and returns the SQL to run:
 * unchanged when the project has no row filters or the query reads no
 * filtered table, otherwise rewritten so every filtered table is read
 * through its predicate. Once the project has row filters, a query reading
 * a table its page doesn't declare is refused.
 */
export async function authorizeQuery(
	page: unknown,
	sql: string,
	headers: Headers
): Promise<QueryAuthzResult> {
	const cwd = getProjectCwd();
	const policies = await pagesWithRowFilters(cwd);
	if (!policies.length) return { ok: true, sql };

	if (typeof page !== 'string') return { ok: false, status: 400, error: 'Missing page parameter' };
	const slug = page.replace(/^\/+|\/+$/g, '');
	const file = slug ? await getMarkdownFile(cwd, slug) : await getHomeFile(cwd);
	if (!file) return { ok: false, status: 404, error: `Page not found: ${slug}` };

	let viewer: ProxyUser | null;
	try {
		viewer = await checkPageAccess(file, headers);
	} catch (e) {
		if (isHttpError(e)) return { ok: false, status: e.status, error: e.body.message };
		throw e;
	}
	const pageRows = Object.entries(policyOf(file)?.rows ?? {});
	const pageTables = declaredTables(file);

	const parsed = await parseSelect(sql);
	if (!parsed.ok) {
		return {
			ok: false,
			status: 400,
			error: parsed.reason === 'not-select' ? parsed.message : 'Query could not be parsed'
		};
	}

	const protectedKeys = policies.flatMap((p) => Object.keys(p.rows));
	const protectedNames = new Set(protectedKeys.map(keyTableName));
	const info = inspect(parsed.statement);

	// A CTE named like a protected table would make `FROM students` mean the
	// CTE in one place and the table in another; refuse rather than guess.
	if ([...info.cteNames].some((name) => protectedNames.has(name))) {
		return { ok: false, status: 403, error: NOT_PERMITTED };
	}
	const blocked = [...info.functions].find(isBlockedFunction);
	if (blocked) {
		return { ok: false, status: 403, error: `${blocked}() is not permitted when row filters are configured.` };
	}

	// Which predicates apply to each table reference.
	const predicatesFor = (ref: Parameters<typeof tableMatches>[1]) =>
		pageRows.filter(([key]) => tableMatches(key, ref)).map(([, predicate]) => predicate);

	// Only tables the page declares are readable at all.
	const undeclared = info.tables.find((ref) => !pageTables.some((key) => tableMatches(key, ref)));
	if (undeclared) {
		const name = [undeclared.catalog, undeclared.schema, undeclared.table].filter(Boolean).join('.');
		return { ok: false, status: 403, error: `Table ${name} is not declared in this page's auth.tables.` };
	}

	let needsRewrite = false;
	for (const ref of info.tables) {
		if (predicatesFor(ref).length) needsRewrite = true;
		else if (protectedKeys.some((key) => tableMatches(key, ref))) {
			return { ok: false, status: 403, error: NOT_PERMITTED };
		}
	}
	if (!needsRewrite) return { ok: true, sql };
	// Only reachable when the page has filters, so checkPageAccess found a viewer.
	if (!viewer) return { ok: false, status: 401, error: 'Sign-in required.' };
	const signedIn = viewer;

	try {
		const templates = new Map<string, JsonNode>();
		for (const ref of info.tables) {
			const predicates = predicatesFor(ref);
			if (!predicates.length) continue;
			const where = combinedPredicate(predicates, signedIn);
			if (!templates.has(where)) templates.set(where, await filterTemplate(where));
		}
		const rewritten = rewriteTables(parsed.statement, (ref, node) => {
			const predicates = predicatesFor(ref);
			if (!predicates.length) return null;
			return filteredRef(templates.get(combinedPredicate(predicates, signedIn))!, node);
		});
		return { ok: true, sql: await deserialize(rewritten) };
	} catch (e) {
		return { ok: false, status: 500, error: `Row filter failed: ${(e as Error).message}` };
	}
}
