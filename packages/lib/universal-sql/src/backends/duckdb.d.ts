/**
 * @param {string} outputFilepath
 */
export function createDuckDBBuilder(outputFilepath: string): Promise<{
    /**
     * @template T
     * @param {string} sourceName
     * @param {string} tableName
     * @param {{name: string, evidenceType: string}[]} columns
     * @param {Generator<T[] | Promise<T[]>, any, any> | T[] | Promise<T[]> | (() => Generator<T[] | Promise<T[]>, any, any>)} data
     * @param {number} [batchSize]
     */
    writeTable<T>(sourceName: string, tableName: string, columns: {
        name: string;
        evidenceType: string;
    }[], data: T[] | Promise<T[]> | Generator<T[] | Promise<T[]>, any, any> | (() => Generator<T[] | Promise<T[]>, any, any>), batchSize?: number): Promise<number>;
    finalize(): Promise<{
        filename: any;
        rowCount: number;
        outputFilepath: any;
    }>;
}>;
/**
 * @param {{
 * 	dataPath: string,
 * 	urlPrefix: string,
 * 	databaseFilename?: string
 * }} options
 */
export function createDuckDBBackend({ dataPath, urlPrefix, databaseFilename }: {
    dataPath: string;
    urlPrefix: string;
    databaseFilename?: string;
}): Promise<{
    name: string;
    manifestBackend: string;
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
    }>;
    finalize(): Promise<{
        databaseFile: {
            name: any;
            url: string;
        };
    }>;
}>;
/**
 * Create a DuckDB backend reader for querying existing .duckdb files
 * @param {{
 * 	databaseFilePath: string
 * }} options
 */
export function createDuckDBBackendReader({ databaseFilePath }: {
    databaseFilePath: string;
}): Promise<{
    name: string;
    /**
     * Initialize the database for reading
     * @returns {Promise<void>}
     */
    initReadDB(): Promise<void>;
    /**
     * Query the database
     * @param {string} sql
     * @returns {Promise<any>}
     */
    queryReadDB(sql: string): Promise<any>;
    /**
     * Get the connection for direct access
     */
    getReadConnection(): any;
    /**
     * Close the connection
     */
    close(): Promise<void>;
}>;
export function handleDuckDBHmr({ sourceName, tableName, queueConnectionReload, queueSourceReload }: {
    sourceName: string;
    tableName: string;
    queueConnectionReload: (sourceName: string) => void;
    queueQueryReload: (sourceName: string, tableName: string) => void;
    queueSourceReload: (sourceName: string) => void;
    warn: (message: string) => void;
}): void;
