import {
	arrowTableToJSON,
	getPromise,
	getDefaultOpenConfig,
	getConnectionConfigQueries,
	createNodeBackendFactory
} from './both.js';
import {
	ConsoleLogger,
	createDuckDB,
	DuckDBAccessMode,
	DuckDBDataProtocol,
	NODE_RUNTIME,
	VoidLogger
} from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking';
import { createRequire } from 'module';
import path, { dirname, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { cache_for_hash, get_arrow_if_sql_already_run } from '../cache-duckdb.js';
import { withTimeout } from './both.js';

const require = createRequire(import.meta.url);
const DUCKDB_DIST = dirname(require.resolve('@duckdb/duckdb-wasm'));

export { tableFromIPC } from 'apache-arrow';

/** @type {import("@duckdb/duckdb-wasm/dist/types/src/bindings/bindings_node_base").DuckDBNodeBindings} */
let db;

/** @type {import("@duckdb/duckdb-wasm/dist/types/src/bindings/connection").DuckDBConnection} */
let connection;

/** @type {{ current: { close?: () => Promise<void> | void } | null } | null} */
let activeExternalConnectionRef = null;
let shutdownHandlersRegistered = false;
/** @type {Promise<void> | null} */
let shutdownPromise = null;

/** @type {Set<Promise<any>>} */
const pendingQueries = new Set();

function registerPendingQuery(promise) {
	pendingQueries.add(promise);
	promise.finally(() => pendingQueries.delete(promise));
}

const { resolve: resolveInit, reject: rejectInit, promise: initPromise } = getPromise();
let initializing = false;

const defaultOpenConfig = getDefaultOpenConfig();

/** @type {ReturnType<typeof createNodeBackendFactory>} */
let backend;

/**
 * @param {string} pathOrUrl
 */
const isDuckLakePath = (pathOrUrl) => /\.ducklake(?:$|\?|#)/i.test(pathOrUrl);

/**
 * @param {string} pathOrUrl
 */
async function createExternalConnection(pathOrUrl) {
	if (!isDuckLakePath(pathOrUrl)) return null;

	const { createDuckLakeBackendReader } = await import('../backends/ducklake.js');
	const reader = await createDuckLakeBackendReader({ databaseFilePath: pathOrUrl });
	await reader.initReadDB();

	return {
		query: (sql) => reader.queryReadDB(sql),
		close: () => reader.close()
	};
}

async function closeActiveExternalConnection() {
	const externalConnection = activeExternalConnectionRef?.current;
	if (!externalConnection?.close) return;
	activeExternalConnectionRef.current = null;
	await externalConnection.close();
}

function registerShutdownHandlers() {
	if (shutdownHandlersRegistered || typeof process === 'undefined') return;
	shutdownHandlersRegistered = true;

	process.once('beforeExit', async () => {
		if (!shutdownPromise) {
			shutdownPromise = Promise.allSettled([...pendingQueries])
				.then(() => closeActiveExternalConnection())
				.catch(() => {});
		}
		await shutdownPromise;
	});
}

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
		const DUCKDB_BUNDLES = {
			mvp: {
				mainModule: resolve(DUCKDB_DIST, './duckdb-mvp.wasm'),
				mainWorker: resolve(DUCKDB_DIST, './duckdb-node-mvp.worker.cjs')
			},
			eh: {
				mainModule: resolve(DUCKDB_DIST, './duckdb-eh.wasm'),
				mainWorker: resolve(DUCKDB_DIST, './duckdb-node-eh.worker.cjs')
			}
		};
		const logger = process.env.VITE_EVIDENCE_DEBUG ? new ConsoleLogger() : new VoidLogger();

		// and synchronous database
		db = await createDuckDB(DUCKDB_BUNDLES, logger, NODE_RUNTIME);
		await db.instantiate();
		db.open(defaultOpenConfig);

		// Initialize backend after db is ready
		const connectionRef = { current: null };
		const externalConnectionRef = { current: null };
		const context = {
			db,
			connectionRef,
			externalConnectionRef,
			createExternalConnection,
			initDB,
			cache_for_hash,
			get_arrow_if_sql_already_run,
			pathSep: path.sep,
			DuckDBDataProtocol,
			DuckDBAccessMode,
			defaultOpenConfig,
			cwd: process.cwd,
			isAbsolutePath: path.isAbsolute,
			resolvePath: path.resolve,
			existsSync,
			readFileSync,
			getBasename: path.basename,
			registerPendingQuery,
			backend: null // Will be set after backend is created
		};
		activeExternalConnectionRef = externalConnectionRef;
		registerShutdownHandlers();
		backend = createNodeBackendFactory(context);
		// Set backend reference in context so it can reference itself
		context.backend = backend;
		// Configure connection after backend is created
		backend.configureConnection();
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
 * @returns {void}
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
 * Adds a new view to the database, pointing to the provided parquet URLs.
 *
 * @param {Record<string, string[]>} urls
 * @param {boolean} [append]
 * @returns {void}
 */
export async function setParquetURLs(urls, options = false) {
	if (!backend) await initDB();
	return backend.setParquetURLs(urls, options);
}

/**
 * Loads a single DuckDB database file into the runtime.
 * @param {string} filePath
 * @returns {void}
 */
export async function loadDuckDBDatabase(filePath, { addBasePath = (x) => x } = {}) {
	if (!backend) await initDB();
	try {
		return await backend.loadDuckDBDatabase(filePath, { addBasePath });
	} catch (e) {
		console.error('[loadDuckDBDatabase] Failed to load:', e);
		throw e;
	}
}

/**
 * Initializes runtime storage from a manifest payload.
 *
 * @param {{
 * 	backend?: 'parquet' | 'duckdb' | 'ducklake' | 'motherduck',
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
 * @param {Parameters<typeof cache_for_hash>[2]} [cache_options]
 * @returns {Record<string, unknown>[]}
 */
export function query(sql, cache_options) {
	if (!backend) {
		throw new Error('Backend not initialized. Call initDB() first.');
	}
	return backend.query(sql, cache_options);
}

/**
 * Returns a Promise that resolves when all currently in-flight external
 * queries have settled. Call this after a pre-render pass to ensure async
 * query results (and their Arrow cache files) are available before reading
 * the prerendered query index.
 * @returns {Promise<PromiseSettledResult<any>[]>}
 */
export function waitForPendingQueries() {
	return Promise.allSettled([...pendingQueries]);
}

export { arrowTableToJSON };
