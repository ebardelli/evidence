import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const doneListeners = [];

	return {
		evalSources: vi.fn(),
		updateManifest: vi.fn(),
		getEvidenceConfig: vi.fn(),
		getStorageBackendHmrHandler: vi.fn(),
		processingQueueFactory: vi.fn(() => ({
			add: vi.fn(async (...fn) => {
				for (const task of fn) {
					const result = task();
					if (result instanceof Promise) await result;
				}
				for (const listener of doneListeners) listener();
			}),
			addListener: vi.fn((event, handler) => {
				if (event === 'done') doneListeners.push(handler);
			})
		})),
		doneListeners,
		serverHotSend: vi.fn()
	};
});

vi.mock('../../../plugins/datasources/evalSources.js', () => ({
	evalSources: mocks.evalSources
}));

vi.mock('../../../plugins/datasources/updateManifest.js', () => ({
	updateManifest: mocks.updateManifest
}));

vi.mock('../../../configuration/getEvidenceConfig.js', () => ({
	getEvidenceConfig: mocks.getEvidenceConfig
}));

vi.mock('../../../lib/processing-queue.js', () => ({
	ProcessingQueue: mocks.processingQueueFactory
}));

vi.mock('../../../lib/projectPaths.js', () => ({
	dataDirectory: '/project/data',
	metaDirectory: '/project/meta',
	sourcesDirectory: '/project/sources'
}));

vi.mock('@evidence-dev/universal-sql', () => ({
	getStorageBackendHmrHandler: mocks.getStorageBackendHmrHandler
}));

import { sourceQueryHmr } from './source-query-hmr.js';
import { VITE_EVENTS } from '../constants.js';

describe('sourceQueryHmr', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.doneListeners.length = 0;
		mocks.evalSources.mockResolvedValue({ backend: 'ducklake' });
		mocks.updateManifest.mockResolvedValue({ backend: 'ducklake' });
	});

	it('uses query-scoped filter options for ducklake HMR updates', async () => {
		mocks.getEvidenceConfig.mockReturnValue({
			buildOptions: {
				storageMode: 'ducklake'
			}
		});
		mocks.getStorageBackendHmrHandler.mockReturnValue(({ sourceName, tableName, queueQueryReload }) => {
			queueQueryReload(sourceName, tableName);
		});

		const plugin = sourceQueryHmr();
		plugin.configureServer?.({
			hot: {
				send: mocks.serverHotSend
			}
		});

		await plugin.watchChange?.('/project/sources/warehouse/orders.sql');
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.evalSources).toHaveBeenCalledWith(
			'/project/data',
			'/project/meta',
			{
				sources: new Set(['warehouse']),
				queries: new Set(['orders']),
				only_changed: false
			},
			true
		);
		expect(mocks.serverHotSend).toHaveBeenCalledWith(
			VITE_EVENTS.SOURCE_START,
			expect.objectContaining({
				id: 'warehouse.orders'
			})
		);
	});

	it('uses query-scoped filter options for duckdb HMR updates', async () => {
		mocks.getEvidenceConfig.mockReturnValue({
			buildOptions: {
				storageMode: 'duckdb'
			}
		});
		mocks.getStorageBackendHmrHandler.mockReturnValue(({ sourceName, tableName, queueQueryReload }) => {
			queueQueryReload(sourceName, tableName);
		});

		const plugin = sourceQueryHmr();
		plugin.configureServer?.({
			hot: {
				send: mocks.serverHotSend
			}
		});

		await plugin.watchChange?.('/project/sources/warehouse/orders.sql');
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.evalSources).toHaveBeenCalledWith(
			'/project/data',
			'/project/meta',
			{
				sources: new Set(['warehouse']),
				queries: new Set(['orders']),
				only_changed: false
			},
			true
		);
		expect(mocks.serverHotSend).toHaveBeenCalledWith(
			VITE_EVENTS.SOURCE_START,
			expect.objectContaining({
				id: 'warehouse.orders'
			})
		);
	});

	it('uses full rebuild filter scope for motherduck HMR updates', async () => {
		mocks.getEvidenceConfig.mockReturnValue({
			buildOptions: {
				storageMode: 'motherduck'
			}
		});
		mocks.getStorageBackendHmrHandler.mockReturnValue(({ sourceName, tableName, queueQueryReload }) => {
			queueQueryReload(sourceName, tableName);
		});

		const plugin = sourceQueryHmr();
		plugin.configureServer?.({
			hot: {
				send: mocks.serverHotSend
			}
		});

		await plugin.watchChange?.('/project/sources/warehouse/orders.sql');
		await Promise.resolve();
		await Promise.resolve();

		expect(mocks.evalSources).toHaveBeenCalledWith(
			'/project/data',
			'/project/meta',
			{
				sources: null,
				queries: null,
				only_changed: false
			},
			true
		);
		expect(mocks.serverHotSend).toHaveBeenCalledWith(
			VITE_EVENTS.SOURCE_START,
			expect.objectContaining({
				id: 'all sources'
			})
		);
	});
});
