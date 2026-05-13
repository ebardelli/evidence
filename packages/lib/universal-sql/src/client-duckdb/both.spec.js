import { describe, expect, it, vi } from 'vitest';
import { createBrowserBackendFactory, createNodeBackendFactory } from './both.js';
import path from 'node:path';

describe('shared backend factory manifest initialization', () => {
	it('updates search path for database-backed external connections', async () => {
		const updateCalls = [];
		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query: vi.fn() } },
			externalConnectionRef: {
				current: {
					query: vi.fn(async () => [])
				}
			},
			db: {
				connect: vi.fn(() => ({ query: vi.fn() })),
				open: vi.fn(),
				reset: vi.fn(),
				flushFiles: vi.fn(),
				globFiles: vi.fn(() => []),
				dropFile: vi.fn()
			},
			defaultOpenConfig: {},
			DuckDBAccessMode: {},
			pathSep: '/',
			cwd: () => '/',
			isAbsolutePath: () => true,
			resolvePath: (...parts) => parts.join('/'),
			existsSync: () => true,
			readFileSync: () => new Uint8Array(),
			getBasename: () => 'db.duckdb',
			cache_for_hash: vi.fn(),
			get_arrow_if_sql_already_run: vi.fn(),
			backend: null
		};

		const backend = createNodeBackendFactory(context);
		context.backend = backend;

		const originalUpdateSearchPath = backend.updateSearchPath;
		backend.updateSearchPath = vi.fn(async (schemas) => {
			updateCalls.push(schemas);
			return originalUpdateSearchPath(schemas);
		});
		backend.loadDuckDBDatabase = vi.fn(async () => {});

		await backend.initializeFromManifest({
			databaseFile: { url: 'md:warehouse?motherduck_token=test' },
			locatedSchemas: ['projections']
		});

		expect(backend.loadDuckDBDatabase).toHaveBeenCalledOnce();
		expect(updateCalls).toEqual([['projections']]);
	});

	it('resolves leading-slash database manifest paths in dev mode', async () => {
		const readFileSync = vi.fn(() => new Uint8Array([1, 2, 3]));
		const existsSync = vi.fn(
			(candidatePath) =>
				candidatePath === '/project/.evidence/template/_evidence/query/evidence.duckdb'
		);
		const db = {
			connect: vi.fn(() => ({ query: vi.fn() })),
			open: vi.fn(),
			reset: vi.fn(),
			flushFiles: vi.fn(),
			globFiles: vi.fn(() => []),
			dropFile: vi.fn(),
			registerFileBuffer: vi.fn()
		};

		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query: vi.fn() } },
			externalConnectionRef: { current: null },
			db,
			defaultOpenConfig: {},
			DuckDBAccessMode: { READ_ONLY: 'READ_ONLY' },
			pathSep: '/',
			cwd: () => '/project',
			isAbsolutePath: (candidatePath) => candidatePath.startsWith('/'),
			resolvePath: (...parts) => path.posix.resolve(...parts),
			existsSync,
			readFileSync,
			getBasename: () => 'evidence.duckdb',
			cache_for_hash: vi.fn(),
			get_arrow_if_sql_already_run: vi.fn(),
			backend: null
		};

		const backend = createNodeBackendFactory(context);
		context.backend = backend;

		await backend.loadDuckDBDatabase('/_evidence/query/evidence.duckdb');

		expect(readFileSync).toHaveBeenCalledWith(
			'/project/.evidence/template/_evidence/query/evidence.duckdb'
		);
		expect(db.registerFileBuffer).toHaveBeenCalledWith('evidence.duckdb', expect.any(Uint8Array));
	});

	it('defaults search path to main when located schemas are empty', async () => {
		const query = vi.fn();
		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query } },
			externalConnectionRef: { current: null },
			db: {
				connect: vi.fn(() => ({ query: vi.fn() })),
				open: vi.fn(),
				reset: vi.fn(),
				flushFiles: vi.fn(),
				globFiles: vi.fn(() => []),
				dropFile: vi.fn()
			},
			defaultOpenConfig: {},
			DuckDBAccessMode: {},
			pathSep: '/',
			cwd: () => '/',
			isAbsolutePath: () => true,
			resolvePath: (...parts) => parts.join('/'),
			existsSync: () => true,
			readFileSync: () => new Uint8Array(),
			getBasename: () => 'db.duckdb',
			cache_for_hash: vi.fn(),
			get_arrow_if_sql_already_run: vi.fn(),
			backend: null
		};

		const backend = createNodeBackendFactory(context);
		context.backend = backend;

		await backend.updateSearchPath([]);

		expect(query).toHaveBeenCalledWith("PRAGMA search_path='main'");
	});

	it('uses external connection for ducklake database manifests in node runtime', async () => {
		const externalQuery = vi.fn(async () => []);
		const createExternalConnection = vi.fn(async () => ({
			query: externalQuery,
			close: vi.fn()
		}));
		const db = {
			connect: vi.fn(() => ({ query: vi.fn() })),
			open: vi.fn(),
			reset: vi.fn(),
			flushFiles: vi.fn(),
			globFiles: vi.fn(() => []),
			dropFile: vi.fn(),
			registerFileBuffer: vi.fn()
		};

		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query: vi.fn() } },
			externalConnectionRef: { current: null },
			createExternalConnection,
			db,
			defaultOpenConfig: {},
			DuckDBAccessMode: { READ_ONLY: 'READ_ONLY', READ_WRITE: 'READ_WRITE' },
			pathSep: '/',
			cwd: () => '/project',
			isAbsolutePath: (candidatePath) => candidatePath.startsWith('/'),
			resolvePath: (...parts) => path.posix.resolve(...parts),
			existsSync: () => false,
			readFileSync: vi.fn(() => new Uint8Array()),
			getBasename: () => 'evidence.ducklake',
			cache_for_hash: vi.fn(),
			get_arrow_if_sql_already_run: vi.fn(),
			backend: null
		};

		const backend = createNodeBackendFactory(context);
		context.backend = backend;

		await backend.loadDuckDBDatabase('/_evidence/query/evidence.ducklake');

		expect(createExternalConnection).toHaveBeenCalledWith('/_evidence/query/evidence.ducklake');
		expect(externalQuery).not.toHaveBeenCalled();
		expect(db.open).not.toHaveBeenCalled();
		expect(db.registerFileBuffer).not.toHaveBeenCalled();
	});

	it('attaches ducklake catalogs in node runtime when external connection is unavailable', async () => {
		const connectionQuery = vi.fn(async () => []);
		const db = {
			connect: vi.fn(() => ({ query: connectionQuery })),
			open: vi.fn(),
			reset: vi.fn(),
			flushFiles: vi.fn(),
			globFiles: vi.fn(() => []),
			dropFile: vi.fn(),
			registerFileBuffer: vi.fn()
		};

		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query: vi.fn() } },
			externalConnectionRef: { current: null },
			createExternalConnection: vi.fn(async () => null),
			db,
			defaultOpenConfig: {},
			DuckDBAccessMode: { READ_ONLY: 'READ_ONLY', READ_WRITE: 'READ_WRITE' },
			pathSep: '/',
			cwd: () => '/project',
			isAbsolutePath: (candidatePath) => candidatePath.startsWith('/'),
			resolvePath: (...parts) => path.posix.resolve(...parts),
			existsSync: (candidatePath) =>
				candidatePath === '/project/.evidence/template/_evidence/query/evidence.ducklake',
			readFileSync: vi.fn(() => new Uint8Array()),
			getBasename: () => 'evidence.ducklake',
			cache_for_hash: vi.fn(),
			get_arrow_if_sql_already_run: vi.fn(),
			backend: null
		};

		const backend = createNodeBackendFactory(context);
		context.backend = backend;

		await backend.loadDuckDBDatabase('/_evidence/query/evidence.ducklake');

		expect(db.reset).toHaveBeenCalledOnce();
		expect(db.open).toHaveBeenCalledWith({
			accessMode: 'READ_WRITE'
		});
		expect(connectionQuery).toHaveBeenCalledWith('LOAD ducklake;');
		expect(connectionQuery).toHaveBeenCalledWith(
			`ATTACH '/project/.evidence/template/_evidence/query/evidence.ducklake' AS "evidence_ducklake" (TYPE ducklake, DATA_PATH '/project/.evidence/template/_evidence/query/evidence.ducklake.data', OVERRIDE_DATA_PATH true, READ_ONLY);`
		);
		expect(connectionQuery).toHaveBeenCalledWith('USE "evidence_ducklake";');
		expect(db.registerFileBuffer).not.toHaveBeenCalled();
	});

	it('reads external connection results through runAndReadAll when query is unavailable', async () => {
		const readAll = vi.fn(async () => {});
		const getRowObjectsJS = vi.fn(() => [{ answer: 42 }]);
		const externalConnection = {
			runAndReadAll: vi.fn(async () => ({
				readAll,
				getRowObjectsJS
			})),
			close: vi.fn()
		};
		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query: vi.fn() } },
			externalConnectionRef: { current: externalConnection },
			db: {
				connect: vi.fn(() => ({ query: vi.fn() })),
				open: vi.fn(),
				reset: vi.fn(),
				flushFiles: vi.fn(),
				globFiles: vi.fn(() => []),
				dropFile: vi.fn(),
				registerFileBuffer: vi.fn()
			},
			defaultOpenConfig: {},
			DuckDBAccessMode: { READ_ONLY: 'READ_ONLY' },
			pathSep: '/',
			cwd: () => '/project',
			isAbsolutePath: (candidatePath) => candidatePath.startsWith('/'),
			resolvePath: (...parts) => path.posix.resolve(...parts),
			existsSync: () => false,
			readFileSync: vi.fn(() => new Uint8Array()),
			getBasename: () => 'evidence.ducklake',
			cache_for_hash: vi.fn(),
			get_arrow_if_sql_already_run: vi.fn(),
			backend: null
		};

		const backend = createNodeBackendFactory(context);
		context.backend = backend;

		await expect(backend.query('select 1')).resolves.toEqual([{ answer: 42 }]);
		expect(externalConnection.runAndReadAll).toHaveBeenCalledWith('select 1');
		expect(readAll).toHaveBeenCalledOnce();
		expect(getRowObjectsJS).toHaveBeenCalledOnce();
	});

	it('attaches ducklake catalogs in browser runtime', async () => {
		const query = vi.fn(async () => []);
		const registerFileURL = vi.fn(async () => {});
		const context = {
			initDB: vi.fn(async () => {}),
			connectionRef: { current: { query } },
			externalConnectionRef: { current: null },
			db: {
				connect: vi.fn(async () => ({ query })),
				open: vi.fn(async () => {}),
				reset: vi.fn(async () => {}),
				flushFiles: vi.fn(async () => {}),
				globFiles: vi.fn(async () => []),
				dropFile: vi.fn(async () => {}),
				registerFileURL
			},
			defaultOpenConfig: {},
			DuckDBDataProtocol: { HTTP: 'HTTP' },
			DuckDBAccessMode: { READ_ONLY: 'READ_ONLY', READ_WRITE: 'READ_WRITE' },
			resolveTables: vi.fn(),
			rejectTables: vi.fn(),
			tablesPromise: Promise.resolve(),
			backend: null
		};

		const backend = createBrowserBackendFactory(context);
		context.backend = backend;

		await backend.loadDuckDBDatabase('/_evidence/query/evidence.ducklake');

		expect(registerFileURL).not.toHaveBeenCalled();
		expect(query).toHaveBeenCalledWith('LOAD ducklake;');
		expect(query).toHaveBeenCalledWith(
			`ATTACH '/_evidence/query/evidence.ducklake' AS "evidence_ducklake" (TYPE ducklake, DATA_PATH '/_evidence/query/evidence.ducklake.data', OVERRIDE_DATA_PATH true, READ_ONLY);`
		);
		expect(query).toHaveBeenCalledWith('USE "evidence_ducklake";');
	});
});
