export { tableFromIPC } from 'apache-arrow';

/**
 * Initializes the database.
 *
 * @returns {Promise<void>}
 */
export function initDB(): Promise<void>;

/**
 * Updates the duckdb search path to include only the list of included schemas
 * @param {string[]} schemas
 * @returns {Promise<void>}
 */
export function updateSearchPath(schemas): Promise<void>;
/**
 * Queries the database with the given SQL statement.
 *
 * @param {string} sql
 * @returns {Promise<Record<string, unknown>[]>}
 */
export function query(sql: string): Promise<Record<string, unknown>[]>;

/**
 * Adds a new view to the database, pointing to the provided parquet URLs.
 *
 * @param {Record<string, string[]>} urls
 * @param {{ append?: boolean, addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export function setParquetURLs(
	urls: Record<string, string[]>,
	opts?: { append?: boolean; addBasePath?: (path: string) => string }
): Promise<void>;

/**
 * Loads a DuckDB database file into the runtime.
 * @param {string} url
 * @param {{ addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export function loadDuckDBDatabase(
	url: string,
	opts?: { addBasePath?: (path: string) => string }
): Promise<void>;

/**
 * Initializes runtime storage from a manifest payload.
 * @param {{
 * 	backend?: 'parquet' | 'duckdb',
 * 	renderedFiles?: Record<string, string[]>,
 * 	databaseFile?: { path?: string; url?: string },
 * 	locatedSchemas?: string[]
 * }} manifest
 * @param {{ addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export function initializeFromManifest(
	manifest?: {
		backend?: 'parquet' | 'duckdb';
		renderedFiles?: Record<string, string[]>;
		databaseFile?: { path?: string; url?: string };
		locatedSchemas?: string[];
	},
	opts?: { addBasePath?: (path: string) => string }
): Promise<void>;

/**
 * Converts an Apache Arrow table to a Javascript array.
 * @param {import("apache-arrow").Table} table
 * @returns {any[]}
 */
export function arrowTableToJSON(table: import('apache-arrow').Table): any[];
