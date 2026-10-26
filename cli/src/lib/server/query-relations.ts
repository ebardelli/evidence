/**
 * Which tables and table functions a SQL statement reads, from DuckDB's own
 * parser (`json_serialize_sql`) — the basis of query-authz.server.ts's
 * per-page allowlist. Runs through `runQuery`, so it only works where the
 * connection *is* DuckDB-flavoured (native `duckdb`, `motherduck`); callers
 * check `supportsRelationCheck` first.
 *
 * Parsing never binds, so it never touches the data or the filesystem, and it
 * works on a locked DuckDB instance (it's a plain SELECT of a scalar).
 */

import { runQuery } from './run-query';

// Connection types whose engine has json_serialize_sql. A Set<string> rather
// than a ConnectionConfig['type'] union so this compiles whether or not the
// native `duckdb` connector is present on this branch.
const RELATION_CHECK_TYPES: ReadonlySet<string> = new Set(['duckdb', 'motherduck']);

export function supportsRelationCheck(connectionType: string | null | undefined): boolean {
	return !!connectionType && RELATION_CHECK_TYPES.has(connectionType);
}

export interface QueryRelations {
	/** Normalized table refs: lowercased, dot-joined, only the segments written. */
	tables: Set<string>;
	/** Lowercased table function names (`read_csv`, `range`, …). */
	functions: Set<string>;
}

export type ParseOutcome =
	| { ok: true; relations: QueryRelations }
	| { ok: false; reason: 'not-select' | 'parse-error'; message: string };

type JsonNode = Record<string, unknown>;

function isObject(value: unknown): value is JsonNode {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cteNames(node: JsonNode): string[] {
	const cteMap = node.cte_map;
	if (!isObject(cteMap) || !Array.isArray(cteMap.map)) return [];
	return cteMap.map
		.map((entry) => (isObject(entry) && typeof entry.key === 'string' ? entry.key.toLowerCase() : ''))
		.filter(Boolean);
}

export function tableKey(catalog: string, schema: string, table: string): string {
	return [catalog, schema, table]
		.filter(Boolean)
		.map((s) => s.toLowerCase())
		.join('.');
}

/**
 * Walks a `json_serialize_sql` result. CTE names are scoped: an unqualified
 * ref to a CTE visible at that point isn't a table read, but the same name
 * outside the CTE's scope is (it'd resolve to a real table there).
 */
export function extractRelations(serialized: unknown): QueryRelations {
	const tables = new Set<string>();
	const functions = new Set<string>();

	function walk(value: unknown, scope: ReadonlySet<string>): void {
		if (Array.isArray(value)) {
			for (const item of value) walk(item, scope);
			return;
		}
		if (!isObject(value)) return;

		const ctes = cteNames(value);
		const innerScope = ctes.length ? new Set([...scope, ...ctes]) : scope;

		if (value.type === 'BASE_TABLE') {
			const catalog = String(value.catalog_name ?? '');
			const schema = String(value.schema_name ?? '');
			const table = String(value.table_name ?? '');
			if (catalog || schema || !innerScope.has(table.toLowerCase())) {
				tables.add(tableKey(catalog, schema, table));
			}
		} else if (value.type === 'TABLE_FUNCTION' && isObject(value.function)) {
			const name = value.function.function_name;
			if (typeof name === 'string') functions.add(name.toLowerCase());
		}

		for (const child of Object.values(value)) walk(child, innerScope);
	}

	walk(serialized, new Set());
	return { tables, functions };
}

// Bounded cache keyed by SQL text — a page's components re-send the same
// wrapper SQL on every load, and parsing is a warehouse round-trip.
const PARSE_CACHE_MAX = 2000;
const parseCache = new Map<string, ParseOutcome>();

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Parses `sql` with the connection's own DuckDB parser. Exactly one SELECT
 * statement parses `ok`; anything else (DDL/DML, SET, multiple statements…)
 * is `not-select`, and a syntax error is `parse-error`.
 */
export async function parseRelations(sql: string): Promise<ParseOutcome> {
	const cached = parseCache.get(sql);
	if (cached) return cached;

	const result = await runQuery(`SELECT json_serialize_sql(${sqlString(sql)}) AS j`);
	if (result.error) {
		// A failure to *run the parser* isn't a verdict on `sql` — don't cache it.
		return { ok: false, reason: 'parse-error', message: result.error };
	}
	const column = result.columns[0]?.name ?? 'j';
	let parsed: JsonNode;
	try {
		parsed = JSON.parse(String(result.rows[0]?.[column])) as JsonNode;
	} catch {
		return { ok: false, reason: 'parse-error', message: 'Unreadable json_serialize_sql output' };
	}

	let outcome: ParseOutcome;
	if (parsed.error === true) {
		outcome =
			parsed.error_type === 'not implemented'
				? { ok: false, reason: 'not-select', message: 'Only single SELECT statements are allowed' }
				: { ok: false, reason: 'parse-error', message: String(parsed.error_message ?? 'Parse error') };
	} else if (!Array.isArray(parsed.statements) || parsed.statements.length !== 1) {
		outcome = { ok: false, reason: 'not-select', message: 'Only single SELECT statements are allowed' };
	} else {
		outcome = { ok: true, relations: extractRelations(parsed.statements) };
	}

	if (parseCache.size >= PARSE_CACHE_MAX) {
		const oldest = parseCache.keys().next().value;
		if (oldest !== undefined) parseCache.delete(oldest);
	}
	parseCache.set(sql, outcome);
	return outcome;
}
