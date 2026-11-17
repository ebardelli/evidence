/**
 * SQL plumbing for `auth.rows` row security (row-security.server.ts): parse a
 * statement with the connection's own DuckDB parser (`json_serialize_sql`),
 * swap table references in the AST for filtered subqueries, and turn the AST
 * back into SQL (`json_deserialize_sql`).
 *
 * Runs through `runQuery`, so it only works where the connection *is*
 * DuckDB-flavoured (native `duckdb`, `motherduck`). Callers check
 * `supportsRowFilters` first. Parsing never binds, so it never touches data.
 */

import { runQuery } from './run-query';

// A Set<string> rather than a ConnectionConfig['type'] union so this compiles
// whether or not the native `duckdb` connector is present on this branch.
const ROW_FILTER_TYPES: ReadonlySet<string> = new Set(['duckdb', 'motherduck']);

export function supportsRowFilters(connectionType: string | null | undefined): boolean {
	return !!connectionType && ROW_FILTER_TYPES.has(connectionType);
}

export type JsonNode = Record<string, unknown>;

export interface TableRef {
	catalog: string;
	schema: string;
	table: string;
}

export type ParseOutcome =
	| { ok: true; statement: JsonNode }
	| { ok: false; reason: 'not-select' | 'parse-error'; message: string };

function isObject(value: unknown): value is JsonNode {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

async function runScalar(sql: string): Promise<string> {
	const result = await runQuery(sql);
	if (result.error) throw new Error(result.error);
	const column = result.columns[0]?.name;
	const value = column ? result.rows[0]?.[column] : undefined;
	if (typeof value !== 'string') throw new Error('Unexpected parser output');
	return value;
}

/**
 * `query_location` is a uint64 whose "unknown" sentinel (2^64-1) doesn't
 * survive JSON.parse, and json_deserialize_sql rejects the rounded value.
 * Positions only matter for error messages, so zero them all.
 */
function parseSerialized(text: string): JsonNode {
	return JSON.parse(text.replace(/"query_location":\s*\d+/g, '"query_location":0')) as JsonNode;
}

const PARSE_CACHE_MAX = 2000;
const parseCache = new Map<string, ParseOutcome>();

/**
 * Parses `sql` with DuckDB. Exactly one SELECT statement is `ok`; anything
 * else (DDL/DML, PIVOT, SET, several statements…) is `not-select`, and a
 * syntax error is `parse-error`. Successful verdicts are cached by SQL text:
 * a page's components re-send the same SQL on every load.
 */
export async function parseSelect(sql: string): Promise<ParseOutcome> {
	const cached = parseCache.get(sql);
	if (cached) return cached;

	let parsed: JsonNode;
	try {
		parsed = parseSerialized(await runScalar(`SELECT json_serialize_sql(${sqlString(sql)}) AS j`));
	} catch (e) {
		// A failure to *run the parser* isn't a verdict on `sql`; don't cache it.
		return { ok: false, reason: 'parse-error', message: (e as Error).message };
	}

	let outcome: ParseOutcome;
	if (parsed.error === true) {
		outcome =
			parsed.error_type === 'not implemented'
				? { ok: false, reason: 'not-select', message: 'Only single SELECT statements are allowed' }
				: { ok: false, reason: 'parse-error', message: String(parsed.error_message ?? 'Parse error') };
	} else if (
		!Array.isArray(parsed.statements) ||
		parsed.statements.length !== 1 ||
		!isObject(parsed.statements[0])
	) {
		outcome = { ok: false, reason: 'not-select', message: 'Only single SELECT statements are allowed' };
	} else {
		outcome = { ok: true, statement: parsed.statements[0] };
	}

	if (parseCache.size >= PARSE_CACHE_MAX) {
		const oldest = parseCache.keys().next().value;
		if (oldest !== undefined) parseCache.delete(oldest);
	}
	parseCache.set(sql, outcome);
	return outcome;
}

/** Turns a parsed statement back into SQL text. */
export function deserialize(statement: JsonNode): Promise<string> {
	const json = JSON.stringify({ error: false, statements: [statement] });
	return runScalar(`SELECT json_deserialize_sql(${sqlString(json)}) AS s`);
}

// ---------------------------------------------------------------------------
// AST inspection
// ---------------------------------------------------------------------------

function unquote(part: string): string {
	return part.replace(/^"(.*)"$/, '$1').toLowerCase();
}

/** The table name a key like `main.students` ends in, lowercased. */
export function keyTableName(key: string): string {
	return unquote(key.split('.').pop() ?? '');
}

/**
 * Whether the `auth.rows` key `key` names `ref`. Table names must be equal;
 * a schema or catalog only has to agree where both sides wrote one, so
 * `students` covers `main.students` and `db.main.students` too. Erring
 * towards a match is the safe direction: it filters more, never less.
 */
export function tableMatches(key: string, ref: TableRef): boolean {
	const keyParts = key.split('.').map(unquote).reverse();
	const refParts = [ref.table, ref.schema, ref.catalog].map((p) => p.toLowerCase());
	if (keyParts[0] !== refParts[0]) return false;
	for (let i = 1; i < 3; i++) {
		if (keyParts[i] && refParts[i] && keyParts[i] !== refParts[i]) return false;
	}
	return true;
}

function refOf(node: JsonNode): TableRef {
	return {
		catalog: String(node.catalog_name ?? ''),
		schema: String(node.schema_name ?? ''),
		table: String(node.table_name ?? '')
	};
}

export interface StatementInfo {
	/** Every table reference (`FROM x`, joins, subqueries, SUMMARIZE/DESCRIBE targets…). */
	tables: TableRef[];
	/** Lowercased names of every CTE defined anywhere in the statement. */
	cteNames: Set<string>;
	/** Lowercased table function names (`read_csv`, `range`, …). */
	functions: Set<string>;
}

export function inspect(statement: JsonNode): StatementInfo {
	const info: StatementInfo = { tables: [], cteNames: new Set(), functions: new Set() };

	function walk(value: unknown): void {
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (!isObject(value)) return;

		const cteMap = value.cte_map;
		if (isObject(cteMap) && Array.isArray(cteMap.map)) {
			for (const entry of cteMap.map) {
				if (isObject(entry) && typeof entry.key === 'string') {
					info.cteNames.add(entry.key.toLowerCase());
				}
			}
		}
		if (value.type === 'BASE_TABLE') {
			info.tables.push(refOf(value));
		} else if (value.type === 'TABLE_FUNCTION' && isObject(value.function)) {
			const name = value.function.function_name;
			if (typeof name === 'string') info.functions.add(name.toLowerCase());
		}

		for (const child of Object.values(value)) walk(child);
	}

	walk(statement);
	return info;
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

const TARGET = '__evidence_row_filter_target__';
const TEMPLATE_CACHE_MAX = 500;
const templateCache = new Map<string, Promise<JsonNode>>();

/**
 * The `SUBQUERY` table ref for `(SELECT * FROM <target> WHERE <predicate>)`,
 * parsed once per predicate text. `<target>` is a placeholder that
 * `filteredRef` replaces with the reference being filtered. Rejects a
 * predicate that doesn't parse as one, e.g. one that tries to close the
 * subquery and add its own clauses.
 */
export function filterTemplate(predicate: string): Promise<JsonNode> {
	let cached = templateCache.get(predicate);
	if (!cached) {
		cached = (async () => {
			const outcome = await parseSelect(
				`SELECT * FROM (SELECT * FROM ${TARGET} WHERE ${predicate}) AS ${TARGET}`
			);
			if (!outcome.ok) throw new Error(`Invalid row filter: ${outcome.message}`);
			const node = outcome.statement.node as JsonNode | undefined;
			const outer = node?.from_table as JsonNode | undefined;
			const inner = (outer?.subquery as JsonNode | undefined)?.node as JsonNode | undefined;
			const target = inner?.from_table as JsonNode | undefined;
			if (
				node?.type !== 'SELECT_NODE' ||
				outer?.type !== 'SUBQUERY' ||
				outer.alias !== TARGET ||
				inner?.type !== 'SELECT_NODE' ||
				target?.type !== 'BASE_TABLE' ||
				target.table_name !== TARGET
			) {
				throw new Error('Invalid row filter: it must be a single WHERE condition');
			}
			return outer;
		})();
		if (templateCache.size >= TEMPLATE_CACHE_MAX) {
			const oldest = templateCache.keys().next().value;
			if (oldest !== undefined) templateCache.delete(oldest);
		}
		templateCache.set(predicate, cached);
		cached.catch(() => templateCache.delete(predicate));
	}
	return cached;
}

/**
 * `ref` (a BASE_TABLE node) wrapped as `(SELECT * FROM ref WHERE …) AS alias`.
 * The alias is the ref's own, or its table name, so column references
 * qualified by either keep resolving.
 */
export function filteredRef(template: JsonNode, ref: JsonNode): JsonNode {
	const wrapper = structuredClone(template);
	const inner = (wrapper.subquery as JsonNode).node as JsonNode;
	inner.from_table = { ...structuredClone(ref), alias: '', column_name_alias: [] };
	wrapper.alias = (ref.alias as string) || String(ref.table_name);
	wrapper.column_name_alias = structuredClone(ref.column_name_alias ?? []);
	return wrapper;
}

/**
 * A copy of `statement` with every BASE_TABLE `replace` returns a node for
 * swapped for that node. Replacements aren't walked again.
 */
export function rewriteTables(
	statement: JsonNode,
	replace: (ref: TableRef, node: JsonNode) => JsonNode | null
): JsonNode {
	function walk(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(walk);
		if (!isObject(value)) return value;
		if (value.type === 'BASE_TABLE') {
			const replacement = replace(refOf(value), value);
			if (replacement) return replacement;
		}
		const out: JsonNode = {};
		for (const [key, child] of Object.entries(value)) out[key] = walk(child);
		return out;
	}
	return walk(statement) as JsonNode;
}
