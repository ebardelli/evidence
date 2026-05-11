/** @type {readonly ['parquet', 'duckdb']} */
export const STORAGE_BACKEND_MODES = ['parquet', 'duckdb'];

/** @type {readonly ['parquet', 'duckdb']} */
export const MANIFEST_BACKEND_MODES = STORAGE_BACKEND_MODES;

/** @type {readonly ['duckdb']} */
export const DATABASE_FILE_BACKENDS = ['duckdb'];

/**
 * @param {unknown} backend
 * @returns {backend is typeof DATABASE_FILE_BACKENDS[number]}
 */
export const usesDatabaseFile = (backend) =>
	typeof backend === 'string' && DATABASE_FILE_BACKENDS.includes(/** @type {any} */ (backend));

/**
 * Browser runtime does not support creating storage backends.
 */
export async function createStorageBackend() {
	throw new Error('createStorageBackend is not available in browser runtime');
}
