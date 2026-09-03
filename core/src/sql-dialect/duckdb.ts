import { MotherDuckDialect } from './motherduck';

/**
 * Local/embedded DuckDB dialect.
 *
 * MotherDuck is cloud DuckDB — same engine, same SQL surface — so this reuses
 * the MotherDuck dialect wholesale and differs only in `name`, so connections
 * can distinguish a local DuckDB file/connection from a MotherDuck warehouse.
 */
export class DuckDBDialect extends MotherDuckDialect {
	override readonly name = 'duckdb';
}
