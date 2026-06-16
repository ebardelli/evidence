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
 * @returns {(context: {
 * 	sourceName: string,
 * 	tableName: string,
 * 	queueConnectionReload: (sourceName: string) => void,
 * 	queueQueryReload: (sourceName: string, tableName: string) => void,
 * 	queueSourceReload: (sourceName: string) => void,
 * 	warn: (message: string) => void
 * }) => void}
 */
export function getStorageBackendHmrHandler() {
	return ({ sourceName, tableName, queueQueryReload }) => {
		queueQueryReload(sourceName, tableName);
	};
}

/**
 * Browser runtime does not support creating storage backends.
 */
export async function createStorageBackend() {
	throw new Error('createStorageBackend is not available in browser runtime');
}
