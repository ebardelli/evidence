import chalk from 'chalk';
import { createParquetBackend } from './parquet.js';
import { createDuckDBBackend } from './duckdb.js';
import { createDuckLakeBackend } from './ducklake.js';

/** @type {readonly ['parquet', 'duckdb', 'ducklake', 'motherduck']} */
export const STORAGE_BACKEND_MODES = ['parquet', 'duckdb', 'ducklake', 'motherduck'];

/** @type {readonly ['parquet', 'duckdb', 'ducklake', 'motherduck']} */
export const MANIFEST_BACKEND_MODES = STORAGE_BACKEND_MODES;

/** @type {readonly ['duckdb', 'ducklake', 'motherduck']} */
export const DATABASE_FILE_BACKENDS = ['duckdb', 'ducklake', 'motherduck'];

/**
 * @param {unknown} backend
 * @returns {backend is typeof DATABASE_FILE_BACKENDS[number]}
 */
export const usesDatabaseFile = (backend) =>
	typeof backend === 'string' && DATABASE_FILE_BACKENDS.includes(/** @type {any} */ (backend));

/**
 * @typedef {{
 * 	name: string,
 * 	manifestBackend?: string,
 * 	capabilities: { filteredBuilds: boolean, externalUrlTables: boolean },
 * 	writeTable: (opts: any) => Promise<{ rowCount: number, renderedFile?: string }>,
 * 	finalize: () => Promise<any>
 * }} StorageBackend
 */

/**
 * @param {typeof STORAGE_BACKEND_MODES[number]} storageMode
 * @param {{
 * 	dataPath: string,
 * 	metaPath: string,
 * 	urlPrefix: string,
 * 	databaseFilename?: string,
 * 	ducklakeDataPath?: string,
 * 	database?: string,
 * 	token?: string,
 * 	readScalingToken?: string
 * }} options
 * @returns {Promise<StorageBackend>}
 */
export async function createStorageBackend(storageMode, options) {
	switch (storageMode) {
		case 'duckdb':
			console.log(chalk.green('✔') + ' Setting up duckdb backend');
			return createDuckDBBackend(options);
		case 'ducklake':
			console.log(chalk.green('✔') + ' Setting up ducklake backend');
			return createDuckLakeBackend(options);
		case 'parquet':
		default:
			console.log(chalk.green('✔') + ' Setting up parquet backend');
			return createParquetBackend(options);
	}
}

export { createParquetBackend, createDuckDBBackend, createDuckLakeBackend };
