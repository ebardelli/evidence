import '../../lib/tests/fs.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	addToCache: vi.fn(),
	buildSourceDirectoryProxy: vi.fn(),
	checkCache: vi.fn(),
	createStorageBackend: vi.fn(),
	flushCache: vi.fn(),
	getBySource: vi.fn(),
	loadCache: vi.fn(),
	loadSourcePlugins: vi.fn(),
	loadSources: vi.fn(),
	logQueryEvent: vi.fn(),
	processSource: vi.fn(),
	testConnection: vi.fn()
}));

vi.mock('./loadSourcePlugins.js', () => ({
	loadSourcePlugins: mocks.loadSourcePlugins
}));

vi.mock('./loadSources.js', () => ({
	loadSources: mocks.loadSources
}));

vi.mock('./buildSourceDirectoryProxy.js', () => ({
	buildSourceDirectoryProxy: mocks.buildSourceDirectoryProxy
}));

vi.mock('./SourceResultCache.js', () => ({
	addToCache: mocks.addToCache,
	checkCache: mocks.checkCache,
	flushCache: mocks.flushCache,
	loadCache: mocks.loadCache
}));

vi.mock('@evidence-dev/universal-sql', () => ({
	createStorageBackend: mocks.createStorageBackend
}));

vi.mock('@evidence-dev/telemetry', () => ({
	logQueryEvent: mocks.logQueryEvent
}));

vi.mock('ora', () => ({
	default: () => {
		const spinner = {
			start: vi.fn(() => spinner),
			succeed: vi.fn(() => spinner),
			fail: vi.fn(() => spinner),
			info: vi.fn(() => spinner),
			warn: vi.fn(() => spinner),
			stopAndPersist: vi.fn(() => spinner)
		};

		return spinner;
	}
}));

import { evalSources } from './evalSources.js';

const makeTable = (name) => ({
	name,
	content: `select * from ${name}`,
	columnTypes: [],
	rows: [{ id: 1 }]
});

describe('evalSources', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mocks.loadSourcePlugins.mockResolvedValue({ getBySource: mocks.getBySource });
		mocks.loadSources.mockResolvedValue([
			{
				name: 'warehouse',
				type: 'duckdb',
				dir: '/sources/warehouse',
				options: {},
				buildOptions: {
					storageMode: 'duckdb'
				}
			}
		]);
		mocks.loadCache.mockResolvedValue(undefined);
		mocks.flushCache.mockResolvedValue(undefined);
		mocks.buildSourceDirectoryProxy.mockResolvedValue({});
		mocks.checkCache.mockReturnValue(false);
		mocks.testConnection.mockResolvedValue(true);
		mocks.getBySource.mockReturnValue([
			{},
			{
				testConnection: mocks.testConnection,
				processSource: mocks.processSource
			}
		]);
	});

	it('does not list duckdb tables in locatedFiles when materialization fails', async () => {
		const writeTable = vi
			.fn()
			.mockRejectedValueOnce(new Error('Extension missing'))
			.mockResolvedValueOnce({ rowCount: 3 });
		const finalize = vi.fn().mockResolvedValue({
			databaseFile: {
				name: 'evidence.duckdb',
				url: '/data/evidence.duckdb'
			}
		});

		mocks.createStorageBackend.mockResolvedValue({
			manifestBackend: 'duckdb',
			capabilities: {
				filteredBuilds: false,
				externalUrlTables: false
			},
			writeTable,
			finalize
		});
		mocks.processSource.mockReturnValue(
			(async function* () {
				yield makeTable('broken');
				yield makeTable('healthy');
			})()
		);

		const manifest = await evalSources('/data', '/meta', undefined, false);

		expect(writeTable).toHaveBeenCalledTimes(2);
		expect(manifest.backend).toBe('duckdb');
		expect(manifest.locatedFiles).toEqual({
			warehouse: ['healthy']
		});
		expect(manifest.databaseFile).toEqual(
			expect.objectContaining({
				name: 'evidence.duckdb'
			})
		);
		expect(mocks.addToCache).toHaveBeenCalledTimes(1);
		expect(mocks.addToCache).toHaveBeenCalledWith('warehouse', 'healthy', 'select * from healthy');
	});

	it('passes ducklake artifact filename to storage backend creation', async () => {
		mocks.loadSources.mockResolvedValue([
			{
				name: 'warehouse',
				type: 'duckdb',
				dir: '/sources/warehouse',
				options: {},
				buildOptions: {
					storageMode: 'ducklake'
				}
			}
		]);

		mocks.createStorageBackend.mockResolvedValue({
			manifestBackend: 'ducklake',
			capabilities: {
				filteredBuilds: false,
				externalUrlTables: false
			},
			writeTable: vi.fn().mockResolvedValue({ rowCount: 1 }),
			finalize: vi.fn().mockResolvedValue({
				databaseFile: {
					name: 'evidence.ducklake',
					url: '/data/evidence.ducklake'
				}
			})
		});
		mocks.processSource.mockReturnValue(
			(async function* () {
				yield makeTable('healthy');
			})()
		);

		await evalSources('/data', '/meta', undefined, false);

		expect(mocks.createStorageBackend).toHaveBeenCalledWith(
			'ducklake',
			expect.objectContaining({
				databaseFilename: 'evidence.ducklake'
			})
		);
	});

	it('allows filtered evals for ducklake when backend supports filtered builds', async () => {
		mocks.loadSources.mockResolvedValue([
			{
				name: 'warehouse',
				type: 'duckdb',
				dir: '/sources/warehouse',
				options: {},
				buildOptions: {
					storageMode: 'ducklake'
				}
			}
		]);

		const writeTable = vi.fn().mockResolvedValue({ rowCount: 1 });
		mocks.createStorageBackend.mockResolvedValue({
			manifestBackend: 'ducklake',
			capabilities: {
				filteredBuilds: true,
				externalUrlTables: false
			},
			writeTable,
			finalize: vi.fn().mockResolvedValue({
				databaseFile: {
					name: 'evidence.ducklake',
					url: '/data/evidence.ducklake'
				}
			})
		});
		mocks.processSource.mockReturnValue(
			(async function* () {
				yield makeTable('healthy');
			})()
		);

		const manifest = await evalSources(
			'/data',
			'/meta',
			{ sources: new Set(['warehouse']), queries: new Set(['healthy']), only_changed: false },
			true
		);

		expect(writeTable).toHaveBeenCalledTimes(1);
		expect(manifest.backend).toBe('ducklake');
	});

	it('allows filtered evals for duckdb when backend supports filtered builds', async () => {
		const writeTable = vi.fn().mockResolvedValue({ rowCount: 1 });
		mocks.createStorageBackend.mockResolvedValue({
			manifestBackend: 'duckdb',
			capabilities: {
				filteredBuilds: true,
				externalUrlTables: false
			},
			writeTable,
			finalize: vi.fn().mockResolvedValue({
				databaseFile: {
					name: 'evidence.duckdb',
					url: '/data/evidence.duckdb'
				}
			})
		});
		mocks.processSource.mockReturnValue(
			(async function* () {
				yield makeTable('healthy');
			})()
		);

		const manifest = await evalSources(
			'/data',
			'/meta',
			{ sources: new Set(['warehouse']), queries: new Set(['healthy']), only_changed: false },
			true
		);

		expect(writeTable).toHaveBeenCalledTimes(1);
		expect(manifest.backend).toBe('duckdb');
	});
});
