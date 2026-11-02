/**
 * Authorizes a serve-mode `/api/query` request against the page that sent it.
 * Self-host only, like page-auth.server.ts.
 *
 * The client still sends SQL text — components wrap a page's named queries in
 * generated SELECTs (filters, sorting, paging, counts, metadata), so the text
 * rarely equals a block on the page. What's checked instead:
 *
 *   1. who: a proxy identity (JWT mode, or plain-header mode only with
 *      EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER=true), required whenever any
 *      page has an `auth:` block;
 *   2. which page: it must exist, and the viewer must pass its `auth:` —
 *      the same assertPageAuthorized (and auth.query cache) as the loader;
 *   3. what it reads: on DuckDB-flavoured connections, every table and table
 *      function the SQL references must be one that page's own queries use
 *      (see buildPageAllowlist). Other connectors stop after step 2.
 *
 * It doesn't stop a viewer writing a different SELECT over tables the page
 * already reads — no row- or column-level guarantees.
 */

import type { Node } from '@markdoc/markdoc';
import { isHttpError } from '@sveltejs/kit';
import { Filters, type SerializedFilters } from '@evidence/core/Filters.svelte';
import { InlineQueries } from '@evidence/core/user-components/common/inline-queries';
import { parseOptionsProp } from '@evidence/core/user-components/tags/dropdown/parse-options-prop';
import { dialectFor } from '@evidence/core/sql-dialect';
import type { AccountVariables } from '@evidence/core/types/account-variables';
import { loadConnectionConfig } from '$cli/connection';
import { process as processMarkdown } from '$lib/markdown';
import {
	discoverMarkdownFiles,
	discoverPartials,
	discoverProjectComponents,
	discoverProjectPartials,
	discoverProjectSqlFiles,
	discoverSqlFiles,
	getHomeFile,
	getMarkdownFile,
	parsePageAuth,
	projectRootRelativePath,
	type MarkdownFile
} from '$lib/markdown/files.server';
import { cliUsesRelativeResolution } from '$lib/markdown/resolution';
import { getProjectCwd } from './project-cwd';
import { isServeMode } from './serve-mode';
import { assertPageAuthorized } from './page-auth.server';
import { getProxyUser } from './proxy-auth.server';
import { loadTranslations } from './translations.server';
import { runQuery } from './run-query';
import { parseRelations, supportsRelationCheck, type QueryRelations } from './query-relations';

export type QueryAuthzResult = { ok: true } | { ok: false; status: number; error: string };

/** On by default in serve mode; `EVIDENCE_QUERY_AUTHZ=off` restores raw SQL for one release. */
export function queryAuthzEnabled(): boolean {
	return isServeMode() && process.env.EVIDENCE_QUERY_AUTHZ !== 'off';
}

export function plainHeaderTrusted(): boolean {
	return process.env.EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER === 'true';
}

export function identityMode(): 'jwt' | 'header' | 'none' {
	if (process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL) return 'jwt';
	if (process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER) return 'header';
	return 'none';
}

// Read by every component that introspects tables (Metadata's catalog load).
// Exposes table and column *names* across attached databases, never rows.
const SYSTEM_TABLES: ReadonlySet<string> = new Set([
	'information_schema.tables',
	'information_schema.columns',
	'information_schema.views'
]);

// Pure generators: no data or filesystem access, safe on any page.
const SAFE_FUNCTIONS: ReadonlySet<string> = new Set(['range', 'generate_series', 'unnest']);

// `{{ $user.* }}` is substituted server-side before SQL ever reaches the
// client, and only ever into value positions — so any placeholder identity
// yields the same tables as the real viewer's.
const PLACEHOLDER_ACCOUNT: AccountVariables = {
	user: { email: 'viewer@example.invalid', first_name: null, last_name: null },
	organization: { name: '' }
};

const MAX_LITERAL_COMBINATIONS = 500;

// ---------------------------------------------------------------------------
// Project discovery (serve mode content is immutable; cache for the process)
// ---------------------------------------------------------------------------

type Discovery = {
	sqlFiles: Record<string, string>;
	partials: Record<string, string>;
	customComponents: Record<string, string>;
};
let discoveryCache: Promise<Discovery> | null = null;
let authPagesCache: Promise<string[]> | null = null;
const allowlistCache = new Map<string, Promise<QueryRelations>>();

// Mirrors [...path]/+page.server.ts's discoverProjectFiles (minus metrics,
// which never carry SQL), so pages expand exactly as the loader renders them.
function discover(cwd: string): Promise<Discovery> {
	return (discoveryCache ??= (async () => {
		if (cliUsesRelativeResolution()) {
			const [sqlFiles, partials, customComponents] = await Promise.all([
				discoverProjectSqlFiles(cwd),
				discoverProjectPartials(cwd),
				discoverProjectComponents(cwd)
			]);
			return { sqlFiles, partials, customComponents };
		}
		const [sqlFiles, partials] = await Promise.all([discoverSqlFiles(cwd), discoverPartials(cwd)]);
		return { sqlFiles, partials, customComponents: {} };
	})());
}

/** Slugs of every page with an `auth:` block. */
export function pagesWithAuth(cwd: string = getProjectCwd()): Promise<string[]> {
	return (authPagesCache ??= discoverMarkdownFiles(cwd).then((files) =>
		files
			.filter((file) => {
				const auth = parsePageAuth(file.content);
				return !!(auth?.users?.length || auth?.query);
			})
			.map((file) => file.slug)
	));
}

/** Test hook: forget everything cached per process. */
export function resetQueryAuthzCaches(): void {
	discoveryCache = null;
	authPagesCache = null;
	allowlistCache.clear();
}

// ---------------------------------------------------------------------------
// Page allowlist
// ---------------------------------------------------------------------------

function collectTags(node: Node, visit: (node: Node) => void): void {
	if (node.type === 'tag') visit(node);
	for (const child of node.children ?? []) collectTags(child, visit);
}

function findFilterTag(ast: Node, id: string): Node | undefined {
	let found: Node | undefined;
	collectTags(ast, (node) => {
		if (!found && node.attributes?.id === id) found = node;
	});
	return found;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every value a `.literal` filter can take: its inline options (`options=`,
 * option children, `default=`) plus its `data` query's distinct values.
 * `null` when none can be computed — callers fail closed.
 */
async function literalOptions(
	id: string,
	serializedFilters: SerializedFilters,
	ast: Node,
	baseQueries: InlineQueries,
	dialect: ReturnType<typeof dialectFor>
): Promise<string[] | null> {
	const attributes = (serializedFilters[id]?.init.attributes ?? {}) as Record<string, unknown>;
	const options = new Set<string>(parseOptionsProp(attributes.options).map((o) => o.value));
	if (typeof attributes.default === 'string') options.add(attributes.default);

	const tag = findFilterTag(ast, id);
	if (tag) {
		for (const child of tag.children ?? []) {
			collectTags(child, (node) => {
				const value = node.attributes?.value;
				if (typeof value === 'string' || typeof value === 'number') options.add(String(value));
			});
		}
	}

	const data = attributes.data;
	const valueColumn = attributes.value_column;
	if (typeof data === 'string' && typeof valueColumn === 'string') {
		const source = baseQueries.getInterpolated(data, dialect) ?? data;
		const result = await runQuery(
			`SELECT DISTINCT ${valueColumn} AS v FROM ${source} LIMIT 10001`
		);
		if (result.error) return options.size ? [...options] : null;
		for (const row of result.rows) {
			if (row.v !== null && row.v !== undefined) options.add(String(row.v));
		}
	}

	return options.size ? [...options] : null;
}

function cartesian(entries: [string, string[]][]): Record<string, string>[] {
	return entries.reduce<Record<string, string>[]>(
		(acc, [id, values]) => acc.flatMap((combo) => values.map((v) => ({ ...combo, [id]: v }))),
		[{}]
	);
}

/**
 * The tables and table functions a page's own queries read, after expanding
 * them the way the client does (query chains, `.sql` refs, `[[ ]]` blocks,
 * filters) — once per value of every `.literal` filter, since those are the
 * only interpolations that can change *which* table a query reads.
 */
async function buildPageAllowlist(cwd: string, file: MarkdownFile): Promise<QueryRelations> {
	const config = await loadConnectionConfig(cwd);
	const connectionType = config?.type ?? null;
	const dialect = dialectFor(connectionType);
	const { sqlFiles, partials, customComponents } = await discover(cwd);
	const useRelativeResolution = cliUsesRelativeResolution();
	const basePath = useRelativeResolution ? projectRootRelativePath(cwd, file.path) : undefined;

	const processed = await processMarkdown(file.content, {
		sqlFiles,
		connectionType,
		partials,
		customComponents,
		basePath,
		useRelativeResolution,
		translations: await loadTranslations(cwd, null),
		account: PLACEHOLDER_ACCOUNT
	});
	const { serializedInlineQueries, serializedFilters, ast } = processed;

	const queriesFor = (url: URL) =>
		new InlineQueries(
			{
				filterContexts: [
					new Filters(
						{
							url: () => url,
							updateUrl: undefined,
							projectSettings: undefined,
							dialect: () => dialect
						},
						serializedFilters
					)
				]
			},
			serializedInlineQueries,
			sqlFiles,
			undefined,
			{ basePath, useRelativeResolution }
		);
	const baseUrl = new URL('http://localhost/');
	const baseQueries = queriesFor(baseUrl);

	// Named sources: every registered query, plus whatever `data=` points at.
	const queryNames = new Set(Object.keys(serializedInlineQueries));
	const rawIdentifiers = new Set<string>();
	collectTags(ast, (node) => {
		const data = node.attributes?.data;
		if (typeof data !== 'string' || !data.trim()) return;
		if (baseQueries.getInterpolated(data, dialect) !== undefined) queryNames.add(data);
		else rawIdentifiers.add(data);
	});

	// `.literal` filters, and which queries interpolate each.
	const rawTexts = Object.entries(serializedInlineQueries);
	const literalIds = Object.keys(serializedFilters).filter((id) =>
		rawTexts.some(([, sql]) => new RegExp(`\\{\\{\\s*${escapeRegExp(id)}\\.literal\\b`).test(sql))
	);
	const optionEntries: [string, string[]][] = [];
	const unexpandable = new Set<string>();
	for (const id of literalIds) {
		const options = await literalOptions(id, serializedFilters, ast, baseQueries, dialect);
		if (options) optionEntries.push([id, options]);
		else unexpandable.add(id);
	}
	if (unexpandable.size) {
		console.warn(
			`query authorization: ${file.slug}: can't list the options of ${[...unexpandable].join(', ')} — queries using them via .literal are blocked`
		);
	}

	let combinations = cartesian(optionEntries);
	if (combinations.length > MAX_LITERAL_COMBINATIONS) {
		// Too many to multiply out: vary one filter at a time instead.
		combinations = optionEntries.flatMap(([id, values]) => values.map((v) => ({ [id]: v })));
	}

	const blockedNames = new Set(
		rawTexts
			.filter(([, sql]) =>
				[...unexpandable].some((id) =>
					new RegExp(`\\{\\{\\s*${escapeRegExp(id)}\\.literal\\b`).test(sql)
				)
			)
			.map(([name]) => name)
	);

	const statements = new Set<string>();
	for (const id of rawIdentifiers) statements.add(`SELECT * FROM ${id}`);
	for (const combo of combinations) {
		const url = new URL(baseUrl);
		for (const [id, value] of Object.entries(combo)) url.searchParams.set(id, value);
		const queries = Object.keys(combo).length ? queriesFor(url) : baseQueries;
		for (const name of queryNames) {
			if (blockedNames.has(name)) continue;
			try {
				const expr = queries.getInterpolated(name, dialect);
				if (expr) statements.add(`SELECT * FROM ${expr}`);
			} catch {
				// A query that can't interpolate can't be rendered by the client either.
			}
		}
	}

	const allowed: QueryRelations = { tables: new Set(), functions: new Set() };
	for (const sql of statements) {
		const outcome = await parseRelations(sql);
		if (!outcome.ok) continue;
		for (const table of outcome.relations.tables) allowed.tables.add(table);
		for (const fn of outcome.relations.functions) allowed.functions.add(fn);
	}
	return allowed;
}

function pageAllowlist(cwd: string, file: MarkdownFile): Promise<QueryRelations> {
	let cached = allowlistCache.get(file.path);
	if (!cached) {
		cached = buildPageAllowlist(cwd, file);
		allowlistCache.set(file.path, cached);
		// Don't pin a transient failure (warehouse down) for the process lifetime.
		cached.catch(() => allowlistCache.delete(file.path));
	}
	return cached;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function authorizeQuery(
	page: string,
	sql: string,
	headers: Headers
): Promise<QueryAuthzResult> {
	const cwd = getProjectCwd();

	// 1. Who.
	const mode = identityMode();
	if (mode === 'header' && !plainHeaderTrusted()) {
		return {
			ok: false,
			status: 401,
			error:
				'Plain-header proxy identity is not trusted for queries. Use JWT mode, or set EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER=true.'
		};
	}
	const viewer = mode === 'none' ? null : await getProxyUser(headers);
	if (!viewer && (await pagesWithAuth(cwd)).length > 0) {
		return { ok: false, status: 401, error: 'Sign-in required.' };
	}

	// 2. Which page.
	const slug = page.replace(/^\/+|\/+$/g, '');
	const file = slug ? await getMarkdownFile(cwd, slug) : await getHomeFile(cwd);
	if (!file) return { ok: false, status: 404, error: `Page not found: ${slug}` };

	try {
		await assertPageAuthorized(parsePageAuth(file.content), headers);
	} catch (e) {
		if (isHttpError(e)) return { ok: false, status: e.status, error: e.body.message };
		throw e;
	}

	// 3. What it reads.
	const config = await loadConnectionConfig(cwd);
	if (!supportsRelationCheck(config?.type)) return { ok: true };

	const outcome = await parseRelations(sql);
	if (!outcome.ok) {
		return {
			ok: false,
			status: 400,
			error:
				outcome.reason === 'not-select'
					? 'Only single SELECT statements are allowed'
					: 'Query could not be parsed'
		};
	}

	const allowed = await pageAllowlist(cwd, file);
	const tablesOk = [...outcome.relations.tables].every(
		(table) => SYSTEM_TABLES.has(table) || allowed.tables.has(table)
	);
	const functionsOk = [...outcome.relations.functions].every(
		(fn) => SAFE_FUNCTIONS.has(fn) || allowed.functions.has(fn)
	);
	if (!tablesOk || !functionsOk) {
		return { ok: false, status: 403, error: 'Query not permitted on this page.' };
	}
	return { ok: true };
}

