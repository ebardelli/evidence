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
 * Removes DuckDB virtual filesystem files matching the provided glob.
 * @param {string} targetGlob
 * @returns {Promise<void>}
 */
export function emptyDbFs(targetGlob: string): Promise<void>;

/**
 * Queries the database with the given SQL statement.
 *
 * @param {string} sql
 * @param {{ route_hash: string, query_name: string, prerendering: boolean }} [cache_options]
 * @returns {Record<string, unknown[]>}
 */
export function query(
	sql: string,
	cache_options?: { route_hash: string; query_name: string; prerendering: boolean }
): Record<string, unknown>[];

/**
 * Adds a new view to the database, pointing to the provided parquet URLs.
 *
 * @param {Record<string, string[]>} urls
 * @param {boolean | { append?: boolean, addBasePath?: (path: string) => string }} [options]
 * @returns {void}
 */
export function setParquetURLs(
	urls: Record<string, string[]>,
	options?: boolean | { append?: boolean; addBasePath?: (path: string) => string }
): void;

/**
 * Loads a DuckDB database file into the runtime.
 * @param {string} filePath
 * @param {{ addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export function loadDuckDBDatabase(
	filePath: string,
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
