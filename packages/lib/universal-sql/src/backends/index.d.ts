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
export function createStorageBackend(storageMode: (typeof STORAGE_BACKEND_MODES)[number], options: {
    dataPath: string;
    metaPath: string;
    urlPrefix: string;
    databaseFilename?: string;
    ducklakeDataPath?: string;
    database?: string;
    token?: string;
    readScalingToken?: string;
}): Promise<StorageBackend>;
/** @type {readonly ['parquet', 'duckdb', 'ducklake', 'motherduck']} */
export const STORAGE_BACKEND_MODES: readonly ['parquet', 'duckdb', 'ducklake', 'motherduck'];
/** @type {readonly ['parquet', 'duckdb', 'ducklake', 'motherduck']} */
export const MANIFEST_BACKEND_MODES: readonly ['parquet', 'duckdb', 'ducklake', 'motherduck'];
/** @type {readonly ['duckdb', 'ducklake', 'motherduck']} */
export const DATABASE_FILE_BACKENDS: readonly ['duckdb', 'ducklake', 'motherduck'];
export function usesDatabaseFile(backend: unknown): backend is "duckdb" | "ducklake" | "motherduck";
export function getStorageBackendHmrHandler(storageMode: (typeof STORAGE_BACKEND_MODES)[number]): StorageBackendHmrHandler;
export type StorageBackend = {
    name: string;
    manifestBackend?: string;
    capabilities: {
        filteredBuilds: boolean;
        externalUrlTables: boolean;
    };
    writeTable: (opts: any) => Promise<{
        rowCount: number;
        renderedFile?: string;
    }>;
    finalize: () => Promise<any>;
};
export type StorageBackendHmrContext = {
    sourceName: string;
    tableName: string;
    queueConnectionReload: (sourceName: string) => void;
    queueQueryReload: (sourceName: string, tableName: string) => void;
    queueSourceReload: (sourceName: string) => void;
    warn: (message: string) => void;
};
export type StorageBackendHmrHandler = (context: StorageBackendHmrContext) => void;
import { createParquetBackend } from './parquet.js';
import { createDuckDBBackend } from './duckdb.js';
import { createDuckLakeBackend } from './ducklake.js';
export { createParquetBackend, createDuckDBBackend, createDuckLakeBackend };
