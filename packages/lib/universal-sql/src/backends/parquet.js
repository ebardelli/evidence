import {
	tableFromArrays,
	tableToIPC,
	vectorFromArray,
	Float64,
	Utf8,
	Bool,
	TimestampMillisecond
} from 'apache-arrow';
import fs from 'fs/promises';
import path from 'path';
import chunk from 'lodash.chunk';
import chalk from 'chalk';

import { columnsToScore } from '../calculateScore.js';
import { log } from '@evidence-dev/sdk/logger';

/**
 * @param {string} tableName
 */
const isConnectionConfigTable = (tableName) =>
	tableName === 'connection' || tableName === 'connection.options';

/**
 * @param {{
 * 	sourceName: string,
 * 	tableName: string,
 * 	queueConnectionReload: (sourceName: string) => void,
 * 	queueQueryReload: (sourceName: string, tableName: string) => void,
 * 	queueSourceReload: (sourceName: string) => void,
 * 	warn: (message: string) => void
 * }} options
 */
export const handleParquetHmr = ({
	sourceName,
	tableName,
	queueConnectionReload,
	queueQueryReload
}) => {
	if (isConnectionConfigTable(tableName)) {
		queueConnectionReload(sourceName);
		return;
	}

	queueQueryReload(sourceName, tableName);
};

// Node.js-specific imports - lazy loaded to avoid issues in browser
let Compression, writeParquet, WriterPropertiesBuilder, Table, DuckDBInstance;
let importsLoaded = false;
/** @type {Promise<void> | null} */
let preloadNodeDependenciesPromise = null;

async function loadNodeDependencies() {
	if (importsLoaded) return;
	if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
		throw new Error('Parquet backend is only available in Node.js environment');
	}

	const parquetWasm = await import('parquet-wasm/node/arrow1.js');
	Compression = parquetWasm.Compression;
	writeParquet = parquetWasm.writeParquet;
	WriterPropertiesBuilder = parquetWasm.WriterPropertiesBuilder;
	Table = parquetWasm.Table;

	const { createRequire } = await import('module');
	const require = createRequire(import.meta.url);
	const nodeApi = require('@duckdb/node-api');
	DuckDBInstance = nodeApi.DuckDBInstance;

	importsLoaded = true;
}

function preloadNodeDependencies() {
	if (!preloadNodeDependenciesPromise) {
		preloadNodeDependenciesPromise = loadNodeDependencies();
	}
	return preloadNodeDependenciesPromise;
}

/**
 * @param {{name: string, evidenceType: string}} column
 * @param {any[]} rawValues
 * @returns {import("apache-arrow").Vector}
 */
function convertArrayToVector(column, rawValues) {
	switch (column.evidenceType) {
		case 'number':
			return vectorFromArray(rawValues, new Float64());
		case 'string':
			return vectorFromArray(rawValues, new Utf8());
		case 'date':
			if (!rawValues.some((v) => v !== null)) {
				console.warn(
					chalk.yellow(
						`\nWarning: Column "${column.name}" (type Date) contains only null values so it has been cast to Float64`
					)
				);
				return vectorFromArray(rawValues, new Float64());
			}
			return vectorFromArray(rawValues, new TimestampMillisecond());
		case 'boolean':
			if (!rawValues.some((v) => v !== null)) {
				console.warn(
					chalk.yellow(
						`\nWarning: Column "${column.name}" (type Bool) contains only null values so it has been cast to Float64`
					)
				);
				return vectorFromArray(rawValues, new Float64());
			}
			return vectorFromArray(rawValues, new Bool());
		default:
			throw new Error(
				'Unrecognized EvidenceType: ' +
					column.evidenceType +
					'\n This is likely an error in a datasource connector.'
			);
	}
}

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
export async function buildMultipartParquet(
	columns,
	data,
	tmpDir,
	outDir,
	outputFilename,
	dbConnectionOrBatchSize,
	batchSize = 1000000
) {
	await preloadNodeDependencies();

	/** @type {any | undefined} */
	let dbConnection = dbConnectionOrBatchSize;
	let effectiveBatchSize = batchSize;

	// Backward compatibility: buildMultipartParquet(..., outputFilename, batchSize)
	if (
		typeof dbConnectionOrBatchSize === 'number' &&
		typeof batchSize === 'number' &&
		batchSize === 1000000
	) {
		effectiveBatchSize = dbConnectionOrBatchSize;
		dbConnection = undefined;
	}

	log.debug(`Building parquet file ${outputFilename}`);
	let { meta: fn_meta, done: fn_done } = log.measure('buildMultipartParquet');
	fn_meta('output filename', outputFilename);

	let batchNum = 0;
	const outputSubpath = outputFilename.split('.parquet')[0];
	/** @type {string[]} */
	let tmpFilenames = [];
	let rowCount = 0;

	const buildId = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

	/** @param {Record<string, unknown>[]} results */
	const flush = async (results) => {
		log.debug(`Flushing batch ${batchNum} with ${results.length} rows`);
		let { meta, done } = log.measure('flush');
		meta('batch number', batchNum);

		const vectorized = /** @type {any} */ (
			Object.fromEntries(
				columns.map((c) => [
					c.name,
					convertArrayToVector(
						c,
						results.map((i) => i[c.name] ?? null)
					)
				])
			)
		);
		const table = /** @type {any} */ (tableFromArrays(vectorized));
		for (const field of table.schema.fields) {
			// @ts-ignore Apache Arrow Field.nullable is writable at runtime
			field.nullable = true;
		}

		const IPC = tableToIPC(table, 'stream');

		const writerProperties = new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build();
		const parquetBuffer = writeParquet(Table.fromIPCStream(IPC), writerProperties);

		const finalTempFilename = path.join(tmpDir, `${outputSubpath}.${buildId}.${batchNum}.parquet`);
		const uniqueSuffix = `.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		const writeTempFilename = finalTempFilename + uniqueSuffix;

		await fs.mkdir(path.dirname(finalTempFilename), { recursive: true });
		await fs.writeFile(writeTempFilename, parquetBuffer);
		await fs.rename(writeTempFilename, finalTempFilename);

		tmpFilenames.push(finalTempFilename);
		rowCount += results.length;

		done();
		log.debug(`Flushed batch ${batchNum} with ${results.length} rows`);

		batchNum++;
	};

	/** @type {any} */
	let normalizedData = data;
	if (typeof normalizedData === 'function') normalizedData = normalizedData();
	if (normalizedData instanceof Promise) normalizedData = await normalizedData;
	if (Array.isArray(normalizedData) && !Array.isArray(normalizedData[0]))
		normalizedData = [normalizedData];
	if (Array.isArray(normalizedData)) {
		const arrays = normalizedData;
		normalizedData = (function* () {
			for (const results of arrays) {
				for (const batch of chunk(results, effectiveBatchSize)) {
					yield batch;
				}
			}
		})();
	}

	log.debug('Reading rows from a generator object');
	let { meta, done } = log.measure('buildMultipartParquet');
	meta('batch number', batchNum);

	const currentBatch = [];
	for await (const results of normalizedData) {
		for (const result of results) currentBatch.push(result);

		if (currentBatch.length >= effectiveBatchSize) {
			done();
			log.debug(`Flushing batch ${batchNum} with ${currentBatch.length} rows`);
			await flush(currentBatch);
			currentBatch.length = 0;
			({ meta, done } = log.measure('buildMultipartParquet'));
			meta('batch number', batchNum);
		}
	}

	done();
	log.debug(`Flushing batch ${batchNum} with ${currentBatch.length} rows`);

	if (currentBatch.length) await flush(currentBatch);

	if (!tmpFilenames.length) return 0;

	const outputFilepath = path.join(outDir, outputFilename);

	const parquetFiles = tmpFilenames.map((filename) => `'${filename.replaceAll('\\', '/')}'`);

	const select = `SELECT * FROM read_parquet([${parquetFiles.join(',')}])`;
	const copy = `COPY (${select}) TO '${outputFilepath}' (FORMAT 'PARQUET', CODEC 'ZSTD', USE_TMP_FILE false);`;

	await fs.mkdir(path.dirname(outputFilepath), { recursive: true });
	if (dbConnection && typeof dbConnection.run === 'function') {
		await dbConnection.run(copy);
	} else {
		const { initDB, query } = await import('../client-duckdb/node.js');
		await initDB();
		await query(copy);
	}

	await fs.chmod(outputFilepath, 0o644);

	const { size } = await fs.stat(outputFilepath);
	if (size > 100 * 1024 * 1024) {
		console.warn(
			chalk.yellow(` Estimated disk size is ${Intl.NumberFormat().format(size / (1024 * 1024))}mb.`)
		);
	}

	const score =
		rowCount *
		columnsToScore(
			columns.map(({ name, evidenceType }) => ({
				name,
				type:
					evidenceType === 'number'
						? 'DOUBLE'
						: evidenceType === 'boolean'
							? 'BOOLEAN'
							: evidenceType === 'date'
								? 'TIMESTAMP'
								: 'VARCHAR'
			}))
		);

	if (score > 100 * 1024 * 1024) {
		console.warn(
			chalk.yellow(
				` WARNING: Estimated output size is ${Intl.NumberFormat().format(
					score / (1024 * 1024)
				)}mb uncompressed. This may cause client-side performance issues.`
			)
		);
	}

	for (const tmpFile of tmpFilenames) {
		await fs.rm(tmpFile, { force: true });
	}

	fn_done();

	return rowCount;
}

/**
 * @param {{
 * 	dataPath: string,
 * 	metaPath: string,
 * 	urlPrefix: string
 * }} options
 */
export async function createParquetBackend({ dataPath, metaPath, urlPrefix }) {
	await preloadNodeDependencies();

	// Initialize database for reading parquet files
	let readDb;
	let readConnection;

	// Initialize database for building/writing parquet files
	let buildDb;
	let buildConnection;

	const initReadDB = async () => {
		if (readDb) return;
		readDb = await DuckDBInstance.create(':memory:', {
			access_mode: 'READ_ONLY',
			custom_user_agent: 'evidence-dev'
		});
		readConnection = await readDb.connect();
		await readConnection.run('SET ieee_floating_point_ops = false;');
		await readConnection.run('SET old_implicit_casting = true;');
	};

	const initBuildDB = async () => {
		if (buildDb) return;
		buildDb = await DuckDBInstance.create(':memory:', {
			access_mode: 'READ_WRITE',
			custom_user_agent: 'evidence-dev'
		});
		buildConnection = await buildDb.connect();
		await buildConnection.run('SET ieee_floating_point_ops = false;');
		await buildConnection.run('SET old_implicit_casting = true;');
	};

	return {
		name: 'parquet',
		manifestBackend: undefined,
		capabilities: {
			filteredBuilds: true,
			externalUrlTables: true
		},

		/**
		 * @param {{
		 * 	sourceName: string,
		 * 	tableName: string,
		 * 	columns: {name: string, evidenceType: string}[],
		 * 	data: Generator<any[] | Promise<any[]>, any, any> | any[] | Promise<any[]> | (() => Generator<any[] | Promise<any[]>, any, any>),
		 * 	batchSize?: number
		 * }} writeOptions
		 */
		async writeTable({ sourceName, tableName, columns, data, batchSize }) {
			await initBuildDB();

			const outDir = path.join(dataPath, sourceName, tableName);
			await fs.mkdir(outDir, { recursive: true });
			const tmpDir = path.join(metaPath, sourceName, tableName, 'tmp');
			await fs.mkdir(tmpDir, { recursive: true });
			const filename = `${tableName}.parquet`;

			const rowCount = await buildMultipartParquet(
				columns,
				data,
				tmpDir,
				outDir,
				filename,
				buildConnection,
				batchSize
			);

			await fs.writeFile(path.join(outDir, `${tableName}.schema.json`), JSON.stringify(columns));

			return {
				rowCount,
				renderedFile: `${urlPrefix}/${sourceName}/${tableName}/${filename}`
			};
		},

		/**
		 * @returns {Promise<{ databaseFile?: never }>}
		 */
		async finalize() {
			// Clean up build database
			if (buildConnection) {
				try {
					buildConnection.disconnectSync();
				} catch {}
			}
			if (buildDb) {
				try {
					buildDb.closeSync();
				} catch {}
			}

			// Clean up read database
			if (readConnection) {
				try {
					readConnection.disconnectSync();
				} catch {}
			}
			if (readDb) {
				try {
					readDb.closeSync();
				} catch {}
			}
			return {};
		},

		/**
		 * Initialize the database for reading parquet files
		 * @returns {Promise<void>}
		 */
		async initReadDB() {
			await initReadDB();
		},

		/**
		 * Query the parquet catalog
		 * @param {string} sql
		 * @returns {Promise<any>}
		 */
		async queryReadDB(sql) {
			if (!readConnection) await initReadDB();
			return readConnection.query(sql);
		},

		/**
		 * Get the connection for direct access
		 */
		getReadConnection() {
			return readConnection;
		}
	};
}
