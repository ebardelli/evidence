import { describe, expect, it, vi } from 'vitest';
import { createNodeBackendFactory } from './both.js';
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
});
