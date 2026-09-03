export type JsType = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'unknown';

/**
 * DuckDB type names → Evidence column JsType. Same engine as MotherDuck, so
 * this mirrors motherduck/type-mapping.ts, plus the underscored spellings
 * (`TIME_TZ`, `TIMESTAMP_TZ`) that @duckdb/node-api's own `DuckDBType#toString()`
 * emits (its `DuckDBTypeId` enum names) — `information_schema.columns.data_type`
 * uses the SQL-standard spelling without underscores, matching MotherDuck.
 *
 * Keys are upper-cased and stripped of any `(...)` precision/length suffix and
 * any trailing `[]` array marker before lookup (see getDuckDBToJsType), so
 * `DECIMAL(18,2)` and `INTEGER[]` both resolve.
 */
const DUCKDB_TYPE_MAP: Record<string, JsType> = {
	BOOLEAN: 'boolean',
	BOOL: 'boolean',
	LOGICAL: 'boolean',

	TINYINT: 'number',
	SMALLINT: 'number',
	INTEGER: 'number',
	INT: 'number',
	INT1: 'number',
	INT2: 'number',
	INT4: 'number',
	INT8: 'number',
	BIGINT: 'number',
	HUGEINT: 'number',
	UTINYINT: 'number',
	USMALLINT: 'number',
	UINTEGER: 'number',
	UBIGINT: 'number',
	UHUGEINT: 'number',
	DECIMAL: 'number',
	NUMERIC: 'number',
	REAL: 'number',
	FLOAT: 'number',
	FLOAT4: 'number',
	FLOAT8: 'number',
	DOUBLE: 'number',

	VARCHAR: 'string',
	CHAR: 'string',
	BPCHAR: 'string',
	TEXT: 'string',
	STRING: 'string',
	UUID: 'string',
	BLOB: 'string',
	BYTEA: 'string',
	BIT: 'string',
	ENUM: 'string',
	INTERVAL: 'string',
	JSON: 'string',

	DATE: 'date',
	TIMESTAMP: 'date',
	DATETIME: 'date',
	TIMESTAMP_S: 'date',
	TIMESTAMP_MS: 'date',
	TIMESTAMP_NS: 'date',
	TIMESTAMPTZ: 'date',
	TIMESTAMP_TZ: 'date',
	'TIMESTAMP WITH TIME ZONE': 'date',
	TIME: 'date',
	TIMETZ: 'date',
	TIME_TZ: 'date',
	'TIME WITH TIME ZONE': 'date',

	STRUCT: 'object',
	MAP: 'object',
	LIST: 'object',
	ARRAY: 'object',
	UNION: 'object'
};

export function getDuckDBToJsType(duckdbType: string): JsType {
	let normalized = duckdbType.toUpperCase().trim();
	// `INTEGER[]` / `VARCHAR[]` etc. — an array of a base type is an object column.
	if (normalized.endsWith('[]')) return 'object';
	// `STRUCT(...)`, `MAP(...)`, `LIST(...)`, `DECIMAL(18,2)` → strip the args, then
	// match on the bare type name.
	normalized = normalized.replace(/\(.*\)/, '').trim();
	return DUCKDB_TYPE_MAP[normalized] ?? 'unknown';
}
