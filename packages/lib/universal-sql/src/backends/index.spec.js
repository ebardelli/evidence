import { describe, expect, it, vi } from 'vitest';
import { getStorageBackendHmrHandler } from './index.js';

const createContextSpies = () => ({
	queueConnectionReload: vi.fn(),
	queueQueryReload: vi.fn(),
	queueSourceReload: vi.fn(),
	warn: vi.fn()
});

describe('getStorageBackendHmrHandler', () => {
	it('dispatches query-table HMR by backend mode', () => {
		const parquet = createContextSpies();
		getStorageBackendHmrHandler('parquet')({
			sourceName: 'warehouse',
			tableName: 'orders',
			...parquet
		});
		expect(parquet.queueQueryReload).toHaveBeenCalledWith('warehouse', 'orders');
		expect(parquet.queueSourceReload).not.toHaveBeenCalled();
		expect(parquet.warn).not.toHaveBeenCalled();

		const duckdb = createContextSpies();
		getStorageBackendHmrHandler('duckdb')({
			sourceName: 'warehouse',
			tableName: 'orders',
			...duckdb
		});
		expect(duckdb.queueQueryReload).toHaveBeenCalledWith('warehouse', 'orders');
		expect(duckdb.queueSourceReload).not.toHaveBeenCalled();
		expect(duckdb.warn).not.toHaveBeenCalled();

		const motherduck = createContextSpies();
		getStorageBackendHmrHandler('motherduck')({
			sourceName: 'warehouse',
			tableName: 'orders',
			...motherduck
		});
		expect(motherduck.queueQueryReload).toHaveBeenCalledWith('warehouse', 'orders');
		expect(motherduck.queueSourceReload).not.toHaveBeenCalled();
		expect(motherduck.warn).not.toHaveBeenCalled();

		const ducklake = createContextSpies();
		getStorageBackendHmrHandler('ducklake')({
			sourceName: 'warehouse',
			tableName: 'orders',
			...ducklake
		});
		expect(ducklake.queueQueryReload).toHaveBeenCalledWith('warehouse', 'orders');
		expect(ducklake.queueSourceReload).not.toHaveBeenCalled();
		expect(ducklake.warn).not.toHaveBeenCalled();
	});

	it('routes connection file changes to connection reload for every backend mode', () => {
		for (const mode of ['parquet', 'duckdb', 'ducklake', 'motherduck']) {
			const context = createContextSpies();
			getStorageBackendHmrHandler(mode)({
				sourceName: 'warehouse',
				tableName: 'connection',
				...context
			});

			expect(context.queueConnectionReload).toHaveBeenCalledWith('warehouse');
			expect(context.queueQueryReload).not.toHaveBeenCalled();
			expect(context.queueSourceReload).not.toHaveBeenCalled();
			expect(context.warn).not.toHaveBeenCalled();
		}
	});
});
