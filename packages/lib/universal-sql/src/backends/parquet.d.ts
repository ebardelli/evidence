/**
 * @template T
 * @param {{name: string, evidenceType: string}[]} columns
 * @param {Generator<T[] | Promise<T[]>, any, any> | T[] | Promise<T[]> | (() => Generator<T[] | Promise<T[]>, any, any>)} data
 * @param {string} tmpDir
 * @param {string} outDir
 * @param {string} outputFilename
 * @param {any} [dbConnectionOrBatchSize] - DuckDB connection instance (preferred) or legacy batchSize
 * @param {number} [batchSize]
 * @returns {Promise<number>} Number of rows
 */
export function buildMultipartParquet<T>(columns: {
    name: string;
    evidenceType: string;
}[], data: T[] | Promise<T[]> | Generator<T[] | Promise<T[]>, any, any> | (() => Generator<T[] | Promise<T[]>, any, any>), tmpDir: string, outDir: string, outputFilename: string, dbConnectionOrBatchSize?: any, batchSize?: number): Promise<number>;
/**
 * @param {{
 * 	dataPath: string,
 * 	metaPath: string,
 * 	urlPrefix: string
 * }} options
 */
export function createParquetBackend({ dataPath, metaPath, urlPrefix }: {
    dataPath: string;
    metaPath: string;
    urlPrefix: string;
}): Promise<{
    name: string;
    manifestBackend: any;
    capabilities: {
        filteredBuilds: boolean;
        externalUrlTables: boolean;
    };
    /**
     * @param {{
     * 	sourceName: string,
     * 	tableName: string,
     * 	columns: {name: string, evidenceType: string}[],
     * 	data: Generator<any[] | Promise<any[]>, any, any> | any[] | Promise<any[]> | (() => Generator<any[] | Promise<any[]>, any, any>),
     * 	batchSize?: number
     * }} writeOptions
     */
    writeTable({ sourceName, tableName, columns, data, batchSize }: {
        sourceName: string;
        tableName: string;
        columns: {
            name: string;
            evidenceType: string;
        }[];
        data: Generator<any[] | Promise<any[]>, any, any> | any[] | Promise<any[]> | (() => Generator<any[] | Promise<any[]>, any, any>);
        batchSize?: number;
    }): Promise<{
        rowCount: number;
        renderedFile: string;
    }>;
    /**
     * @returns {Promise<{ databaseFile?: never }>}
     */
    finalize(): Promise<{
        databaseFile?: never;
    }>;
    /**
     * Initialize the database for reading parquet files
     * @returns {Promise<void>}
     */
    initReadDB(): Promise<void>;
    /**
     * Query the parquet catalog
     * @param {string} sql
     * @returns {Promise<any>}
     */
    queryReadDB(sql: string): Promise<any>;
    /**
     * Get the connection for direct access
     */
    getReadConnection(): any;
}>;
export function handleParquetHmr({ sourceName, tableName, queueConnectionReload, queueQueryReload }: {
    sourceName: string;
    tableName: string;
    queueConnectionReload: (sourceName: string) => void;
    queueQueryReload: (sourceName: string, tableName: string) => void;
    queueSourceReload: (sourceName: string) => void;
    warn: (message: string) => void;
}): void;
