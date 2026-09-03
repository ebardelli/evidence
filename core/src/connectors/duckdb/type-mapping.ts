import { getMotherduckToJsType, type JsType } from '../motherduck/type-mapping';

/**
 * DuckDB type names → Evidence column JsType. Same engine as MotherDuck, so
 * this defers to motherduck/type-mapping.ts, after mapping the underscored
 * spellings (`TIME_TZ`, `TIMESTAMP_TZ`) that @duckdb/node-api's own
 * `DuckDBType#toString()` emits (its `DuckDBTypeId` enum names) onto the
 * `TIMETZ` / `TIMESTAMPTZ` spellings `information_schema.columns.data_type` uses.
 */
export function getDuckDBToJsType(duckdbType: string): JsType {
	return getMotherduckToJsType(duckdbType.replace(/\b(TIME|TIMESTAMP)_TZ\b/i, '$1TZ'));
}
