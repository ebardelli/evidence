import {
	arrowTableToJSON,
	getPromise,
	withTimeout,
	getDefaultOpenConfig,
	getConnectionConfigQueries,
	createBrowserBackendFactory
} from './both.js';
import {
	AsyncDuckDB,
	ConsoleLogger,
	DuckDBAccessMode,
	DuckDBDataProtocol,
	getPlatformFeatures,
	VoidLogger
} from '@duckdb/duckdb-wasm';

export { tableFromIPC } from 'apache-arrow';

/** @type {import("@duckdb/duckdb-wasm").AsyncDuckDB} */
let db;

/** @type {import("@duckdb/duckdb-wasm").AsyncDuckDBConnection} */
let connection;

const { resolve: resolveInit, reject: rejectInit, promise: initPromise } = getPromise();
const { resolve: resolveTables, reject: rejectTables, promise: tablesPromise } = getPromise();
let initializing = false;

const defaultOpenConfig = getDefaultOpenConfig();

/** @type {ReturnType<typeof createBrowserBackendFactory>} */
let backend;

export async function initDB() {
	// If the database is already available, don't do anything
	if (db) return;

	// If the database is already initializing, don't try to do it twice
	// Instead, let the call wait for the initPromise
	if (initializing) return withTimeout(initPromise);
	// This call is the first (to execute), don't let anybody else try
	// to initialize the database
	initializing = true;
	try {
		const useEh = await getPlatformFeatures().then((x) => x.wasmExceptions);

		const DUCKDB_CONFIG = useEh
			? {
					mainModule: (await import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url')).default,
					mainWorker: (await import('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?worker'))
						.default
				}
			: {
					mainModule: (await import('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url')).default,
					mainWorker: (await import('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?worker'))
						.default
				};

		const logger = import.meta.env.VITE_EVIDENCE_DEBUG ? new ConsoleLogger() : new VoidLogger();
		const worker = new DUCKDB_CONFIG.mainWorker();

		// use an intermediate variable to prevent db from being a not-ready database
		const _db = new AsyncDuckDB(logger, worker);
		window[Symbol.for('EVIDENCE_QUERY_ENGINE')] = _db;

		await _db.instantiate(DUCKDB_CONFIG.mainModule);
		db = _db;

		await db.open(defaultOpenConfig);

		// Initialize backend after db is ready
		const connectionRef = { current: null };
		const context = {
			db,
			connectionRef,
			externalConnectionRef: { current: null },
			initDB,
			DuckDBDataProtocol,
			DuckDBAccessMode,
			defaultOpenConfig,
			resolveTables,
			rejectTables,
			tablesPromise,
			backend: null // Will be set after backend is created
		};
		backend = createBrowserBackendFactory(context);
		// Set backend reference in context so it can reference itself
		context.backend = backend;
		// Configure connection after backend is created
		await backend.configureConnection();
		connection = connectionRef.current;

		resolveInit();
	} catch (e) {
		rejectInit(e);
		throw e;
	}
}

/**
 * Updates the duckdb search path to include only the list of included schemas
 * @param {string[]} schemas
 * @returns {Promise<void>}
 */
export async function updateSearchPath(schemas) {
	if (!backend) await initDB();
	return backend.updateSearchPath(schemas);
}

/**
 * @param {string} targetGlob
 */
export async function emptyDbFs(targetGlob) {
	if (!backend) await initDB();
	return backend.emptyDbFs(targetGlob);
}

/**
 * Adds a new view to the database, pointing to the provided parquet URL.
 * @param {Record<string, string[]>} urls
 * @param {{ append?: boolean, addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export async function setParquetURLs(urls, { append, addBasePath = (x) => x } = {}) {
	if (!backend) await initDB();
	return backend.setParquetURLs(urls, { append, addBasePath });
}

/**
 * Loads a single DuckDB database file into the runtime.
 * @param {string} url
 * @param {{ addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export async function loadDuckDBDatabase(url, { addBasePath = (x) => x } = {}) {
	if (!backend) await initDB();
	return backend.loadDuckDBDatabase(url, { addBasePath });
}

/**
 * Initializes runtime storage from a manifest payload.
 *
 * @param {{
 * 	backend?: 'parquet' | 'duckdb',
 * 	renderedFiles?: Record<string, string[]>,
 * 	databaseFile?: { path?: string, url?: string },
 * 	locatedSchemas?: string[]
 * }} manifest
 * @param {{ addBasePath?: (path: string) => string }} [opts]
 * @returns {Promise<void>}
 */
export async function initializeFromManifest(manifest = {}, { addBasePath = (x) => x } = {}) {
	if (!backend) await initDB();
	return backend.initializeFromManifest(manifest, { addBasePath });
}

/**
 * Queries the database with the given SQL statement.
 *
 * @param {string} sql
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function query(sql) {
	if (!backend) await initDB();
	return backend.query(sql);
}

/**
 * No-op in browser context — pending query tracking only applies server-side.
 * Included for API compatibility with the Node backend.
 * @returns {Promise<void>}
 */
export async function waitForPendingQueries() {}

export { arrowTableToJSON };
