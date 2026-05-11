import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	initDB: vi.fn(async () => {}),
	loadDuckDBDatabase: vi.fn(async () => {}),
	setParquetURLs: vi.fn(async () => {}),
	updateSearchPath: vi.fn(async () => {}),
	query: vi.fn(async () => []),
	tableFromIPC: vi.fn(async () => ({})),
	arrowTableToJSON: vi.fn(() => [])
}));

vi.mock('$app/environment', () => ({
	browser: true,
	building: false,
	dev: false
}));

vi.mock('@evidence-dev/universal-sql/client-duckdb', () => ({
	tableFromIPC: mocks.tableFromIPC,
	initDB: mocks.initDB,
	loadDuckDBDatabase: mocks.loadDuckDBDatabase,
	setParquetURLs: mocks.setParquetURLs,
	query: mocks.query,
	updateSearchPath: mocks.updateSearchPath,
	arrowTableToJSON: mocks.arrowTableToJSON
}));

vi.mock('@evidence-dev/component-utilities/profile', () => ({
	profile: async (fn, ...args) => {
		if (typeof fn === 'function') return fn(...args);
		return fn;
	}
}));

vi.mock('@evidence-dev/component-utilities/stores', () => ({
	toasts: {
		add: vi.fn()
	}
}));

vi.mock('@evidence-dev/sdk/usql', () => ({
	setTrackProxy: (value) => value
}));

vi.mock('@evidence-dev/sdk/utils/svelte', () => ({
	addBasePath: (path) => path
}));

function buildApiFetch() {
	return vi.fn(async (url) => {
		if (url === '/api/customFormattingSettings.json/GET.json') {
			return { ok: true, json: async () => ({ customFormattingSettings: {} }) };
		}

		if (url === '/api/pagesManifest.json') {
			return {
				ok: true,
				json: async () => ({
					children: {
						settings: {
							children: {},
							frontMatter: {}
						}
					}
				})
			};
		}

		return { ok: true, json: async () => ({ queries: [] }) };
	});
}

describe('+layout runtime manifest initialization', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	it('initializes duckdb backend from manifest and updates search path', async () => {
		const manifest = {
			backend: 'duckdb',
			databaseFile: { name: 'evidence.duckdb', url: '/data/evidence.duckdb' },
			locatedSchemas: ['warehouse']
		};

		globalThis.fetch = vi.fn(async (url) => {
			if (url === '/data/manifest.json') return { ok: true, json: async () => manifest };
			return { ok: false, json: async () => ({}) };
		});

		const { load } = await import('./+layout.js');
		const pageData = await load({
			fetch: buildApiFetch(),
			route: { id: '/settings' },
			params: {},
			url: new URL('http://localhost/settings')
		});

		await pageData.__db.load();

		expect(mocks.initDB).toHaveBeenCalled();
		expect(mocks.loadDuckDBDatabase).toHaveBeenCalledWith(
			'/data/evidence.duckdb',
			expect.objectContaining({ addBasePath: expect.any(Function) })
		);
		expect(mocks.updateSearchPath).toHaveBeenCalledWith(['warehouse']);
		expect(mocks.setParquetURLs).not.toHaveBeenCalled();

		vi.clearAllMocks();
		await pageData.__db.updateParquetURLs(JSON.stringify(manifest));
		expect(mocks.loadDuckDBDatabase).toHaveBeenCalledWith(
			'/data/evidence.duckdb',
			expect.objectContaining({ addBasePath: expect.any(Function) })
		);
		expect(mocks.updateSearchPath).toHaveBeenCalledWith(['warehouse']);
		expect(mocks.setParquetURLs).not.toHaveBeenCalled();
	});

	it('initializes parquet backend from renderedFiles and updates search path', async () => {
		const manifest = {
			renderedFiles: {
				warehouse: ['data/warehouse/orders.parquet']
			}
		};

		globalThis.fetch = vi.fn(async (url) => {
			if (url === '/data/manifest.json') return { ok: true, json: async () => manifest };
			return { ok: false, json: async () => ({}) };
		});

		const { load } = await import('./+layout.js');
		const pageData = await load({
			fetch: buildApiFetch(),
			route: { id: '/settings' },
			params: {},
			url: new URL('http://localhost/settings')
		});

		await pageData.__db.load();

		expect(mocks.initDB).toHaveBeenCalled();
		expect(mocks.setParquetURLs).toHaveBeenCalledWith(
			manifest.renderedFiles,
			expect.objectContaining({ addBasePath: expect.any(Function) })
		);
		expect(mocks.updateSearchPath).toHaveBeenCalledWith(['warehouse']);
		expect(mocks.loadDuckDBDatabase).not.toHaveBeenCalled();

		vi.clearAllMocks();
		await pageData.__db.updateParquetURLs(JSON.stringify(manifest));
		expect(mocks.setParquetURLs).toHaveBeenCalledWith(
			manifest.renderedFiles,
			expect.objectContaining({ addBasePath: expect.any(Function) })
		);
		expect(mocks.loadDuckDBDatabase).not.toHaveBeenCalled();
	});
});
