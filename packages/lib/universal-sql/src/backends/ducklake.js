import {
	tableFromArrays,
	tableToIPC,
	vectorFromArray,
	Float64,
	Utf8,
	Bool,
	TimestampMillisecond
} from 'apache-arrow';
import path from 'path';
import fs from 'fs/promises';
import chunk from 'lodash.chunk';
import chalk from 'chalk';

import { columnsToScore } from '../calculateScore.js';
import { log } from '@evidence-dev/sdk/logger';

// Node.js-specific imports - lazy loaded to avoid issues in browser
/** @type {any} */
let Compression;
/** @type {any} */
let writeParquet;
/** @type {any} */
let WriterPropertiesBuilder;
/** @type {any} */
let Table;
/** @type {any} */
let DuckDBInstance;
let importsLoaded = false;

const DUCKLAKE_ATTACH_NAME = 'evidence_ducklake';
const ABSOLUTE_HTTP_URL_REGEX = /^https?:\/\//i;

async function loadNodeDependencies() {
	if (importsLoaded) return;
	if (typeof process === 'undefined' || !process.versions || !process.versions.node) {
		throw new Error('DuckLake backend is only available in Node.js environment');
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
 * @param {string} identifier
 */
const quoteIdentifier = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

/**
 * @param {string} value
 */
const toSQLString = (value) => `'${value.replaceAll("'", "''")}'`;

/**
 * @param {string} value
 */
const toDuckDBPath = (value) => value.replaceAll('\\', '/');

/**
 * @param {string} prefix
 * @param {string} suffix
 */
const joinUrlPath = (prefix, suffix) => {
	const left = prefix.replace(/\/+$/, '');
	const right = suffix.replace(/^\/+/, '');
	return `${left}/${right}`;
};

/**
 * @param {string} value
 */
const normalizeOrigin = (value) => {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (ABSOLUTE_HTTP_URL_REGEX.test(trimmed)) return trimmed.replace(/\/+$/, '');
	return `https://${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
};

/**
 * @param {boolean} isBuilding
 */
const resolveDuckLakeOrigin = (isBuilding) => {
	if (isBuilding) {
		const deployOriginCandidates = [
			process.env.EVIDENCE_DUCKLAKE_DEPLOY_ORIGIN,
			process.env.EVIDENCE_DEPLOY_ORIGIN,
			process.env.EVIDENCE_PUBLIC_ORIGIN,
			process.env.DEPLOY_URL,
			process.env.DEPLOY_PRIME_URL,
			process.env.URL,
			process.env.CF_PAGES_URL,
			process.env.VERCEL_PROJECT_PRODUCTION_URL,
			process.env.VERCEL_URL
		];
		for (const candidate of deployOriginCandidates) {
			if (!candidate) continue;
			const normalized = normalizeOrigin(candidate);
			if (normalized) return normalized;
		}
		return '';
	}

	const localOriginCandidates = [
		process.env.EVIDENCE_DUCKLAKE_LOCAL_ORIGIN,
		process.env.EVIDENCE_LOCAL_ORIGIN,
		process.env.EVIDENCE_DEV_ORIGIN
	];
	for (const candidate of localOriginCandidates) {
		if (!candidate) continue;
		const normalized = normalizeOrigin(candidate);
		if (normalized) return normalized;
	}

	const localPort = process.env.EVIDENCE_DEV_PORT || process.env.PORT || '3000';
	return `http://localhost:${localPort}`;
};

/**
 * Resolve the URL prefix used as the base for persisted DuckLake DATA_PATH values.
 * - In dev/preview/sources flows: prefer localhost origin
 * - In build/deploy flows: prefer deploy origin vars
 * - If urlPrefix is already absolute http(s), it is used as-is
 *
 * @param {string} urlPrefix
 */
export const resolveDuckLakeRemoteUrlPrefix = (urlPrefix) => {
	if (ABSOLUTE_HTTP_URL_REGEX.test(urlPrefix)) return urlPrefix;

	const isBuilding = process.env.EVIDENCE_IS_BUILDING === 'true';
	const origin = resolveDuckLakeOrigin(isBuilding);
	if (!origin) {
		if (isBuilding) {
			console.warn(
				chalk.yellow(
					`DuckLake build detected a relative data URL prefix (${urlPrefix}) but no deploy origin was found. Falling back to relative DATA_PATH. Set EVIDENCE_DUCKLAKE_DEPLOY_ORIGIN (or EVIDENCE_DEPLOY_ORIGIN) to persist absolute deploy URLs.`
				)
			);
		}
		return urlPrefix;
	}

	return joinUrlPath(origin, urlPrefix);
};

/**
 * @param {string} evidenceType
 */
const evidenceTypeToSQL = (evidenceType) => {
	switch (evidenceType) {
		case 'number':
			return 'DOUBLE';
		case 'boolean':
			return 'BOOLEAN';
		case 'date':
			return 'TIMESTAMP';
		case 'string':
		default:
			return 'VARCHAR';
	}
};

/**
 * @param {{name: string, evidenceType: string}[]} columns
 * @param {Record<string, unknown>[]} results
 */
function resultsToIPC(columns, results) {
	const vectorized = /** @type {any} */ (
		Object.fromEntries(
			columns.map((c) => [
				c.name,
				convertArrayToVector(
					c,
					results.map((row) => row[c.name] ?? null)
				)
			])
		)
	);
	const table = /** @type {any} */ (tableFromArrays(vectorized));
	for (const field of table.schema.fields) {
		// @ts-ignore Apache Arrow Field.nullable is writable at runtime
		field.nullable = true;
	}
	return tableToIPC(table, 'stream');
}

/**
 * @param {any} connection
 */
async function loadDuckLakeExtension(connection) {
	try {
		await connection.run('INSTALL ducklake;');
	} catch {}
	await connection.run('LOAD ducklake;');
}

/**
 * @param {{
 *  outputFilepath: string,
 *  localDataPath: string,
 *  remoteDataPath: string
 * }} options
 */
export async function createDuckLakeBuilder({ outputFilepath, localDataPath, remoteDataPath }) {
	await loadNodeDependencies();

	const resolvedOutputFilepath = path.resolve(outputFilepath);
	const resolvedLocalDataPath = path.resolve(localDataPath);
	const outputFilename = path.basename(resolvedOutputFilepath);

	await fs.mkdir(path.dirname(resolvedOutputFilepath), { recursive: true });
	await fs.mkdir(resolvedLocalDataPath, { recursive: true });

	const db = await DuckDBInstance.create(':memory:', {
		access_mode: 'READ_WRITE',
		custom_user_agent: 'evidence-dev'
	});
	const connection = await db.connect();
	await connection.run('SET ieee_floating_point_ops = false;');
	await connection.run('SET old_implicit_casting = true;');
	await loadDuckLakeExtension(connection);

	const attachIdentifier = quoteIdentifier(DUCKLAKE_ATTACH_NAME);
	const catalogPathSQL = toSQLString(toDuckDBPath(resolvedOutputFilepath));
	const remoteDataPathSQL = toSQLString(remoteDataPath);
	const localDataPathSQL = toSQLString(toDuckDBPath(resolvedLocalDataPath));

	await connection.run(
		`ATTACH ${catalogPathSQL} AS ${attachIdentifier} (TYPE ducklake, DATA_PATH ${remoteDataPathSQL});`
	);
	await connection.run(`DETACH ${attachIdentifier};`);
	await connection.run(
		`ATTACH ${catalogPathSQL} AS ${attachIdentifier} (TYPE ducklake, DATA_PATH ${localDataPathSQL}, OVERRIDE_DATA_PATH true);`
	);
	await connection.run(`USE ${attachIdentifier};`);

	let totalRowCount = 0;
	let totalScore = 0;
	const tempRoot = path.join(path.dirname(resolvedOutputFilepath), '.tmp-ducklake-build');
	await fs.mkdir(tempRoot, { recursive: true });

	return {
		/**
		 * @template T
		 * @param {string} sourceName
		 * @param {string} tableName
		 * @param {{name: string, evidenceType: string}[]} columns
		 * @param {Generator<T[] | Promise<T[]>, any, any> | T[] | Promise<T[]> | (() => Generator<T[] | Promise<T[]>, any, any>)} data
		 * @param {number} [batchSize]
		 */
		async writeTable(sourceName, tableName, columns, data, batchSize = 1000000) {
			const schemaName = quoteIdentifier(sourceName);
			const relationName = quoteIdentifier(tableName);

			await connection.run(`CREATE SCHEMA IF NOT EXISTS ${schemaName};`);
			await connection.run(`DROP TABLE IF EXISTS ${schemaName}.${relationName};`);

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
						for (const batch of chunk(results, batchSize)) {
							yield batch;
						}
					}
				})();
			}

			let rowCount = 0;
			const currentBatch = [];
			let batchNum = 0;
			const outputSubpath = `${sourceName}__${tableName}`;
			const buildId = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
			/** @type {string[]} */
			const tempParquetFiles = [];

			/** @param {Record<string, unknown>[]} results */
			const flush = async (results) => {
				if (!results.length) return;
				const ipc = resultsToIPC(columns, results);
				const writerProperties = new WriterPropertiesBuilder()
					.setCompression(Compression.ZSTD)
					.build();
				const parquetBuffer = writeParquet(Table.fromIPCStream(ipc), writerProperties);

				const tempFilename = path.join(tempRoot, `${outputSubpath}.${buildId}.${batchNum}.parquet`);
				const writeTempFilename = `${tempFilename}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

				await fs.writeFile(writeTempFilename, parquetBuffer);
				await fs.rename(writeTempFilename, tempFilename);
				tempParquetFiles.push(tempFilename);

				batchNum++;
				rowCount += results.length;
			};

			for await (const results of normalizedData) {
				for (const result of results) currentBatch.push(result);

				if (currentBatch.length >= batchSize) {
					await flush(currentBatch);
					currentBatch.length = 0;
				}
			}

			await flush(currentBatch);

			if (tempParquetFiles.length) {
				const parquetFiles = tempParquetFiles.map(
					(filename) => `'${filename.replaceAll('\\', '/').replaceAll("'", "''")}'`
				);
				await connection.run(
					`CREATE OR REPLACE TABLE ${schemaName}.${relationName} AS SELECT * FROM read_parquet([${parquetFiles.join(',')}]);`
				);
			} else {
				const emptyColumns = columns
					.map(
						({ name, evidenceType }) =>
							`${quoteIdentifier(name)} ${evidenceTypeToSQL(evidenceType)}`
					)
					.join(', ');
				await connection.run(`CREATE TABLE ${schemaName}.${relationName} (${emptyColumns});`);
			}

			for (const tmpFile of tempParquetFiles) {
				await fs.rm(tmpFile, { force: true });
			}

			totalRowCount += rowCount;
			totalScore +=
				rowCount *
				columnsToScore(
					columns.map(({ name, evidenceType }) => ({
						name,
						type: evidenceTypeToSQL(evidenceType)
					}))
				);

			return rowCount;
		},

		async finalize() {
			try {
				await connection.run(`CALL ducklake_flush_inlined_data(${toSQLString(DUCKLAKE_ATTACH_NAME)});`);

				try {
					connection.disconnectSync();
				} catch {}
				try {
					db.closeSync();
				} catch {}

				const { size } = await fs.stat(resolvedOutputFilepath);
				if (size > 100 * 1024 * 1024) {
					console.warn(
						chalk.yellow(
							` Estimated disk size is ${Intl.NumberFormat().format(size / (1024 * 1024))}mb.`
						)
					);
				}

				if (totalScore > 100 * 1024 * 1024) {
					console.warn(
						chalk.yellow(
							` WARNING: Estimated output size is ${Intl.NumberFormat().format(
								totalScore / (1024 * 1024)
							)}mb uncompressed. This may cause client-side performance issues.`
						)
					);
				}

				log.debug(`Built DuckLake catalog file ${resolvedOutputFilepath}`);

				await fs.rm(tempRoot, { recursive: true, force: true });

				return {
					filename: outputFilename,
					rowCount: totalRowCount,
					outputFilepath: resolvedOutputFilepath
				};
			} catch (error) {
				const errorStr = error instanceof Error ? error.message : String(error);
				log.error(`Error finalizing DuckLake catalog: ${errorStr}`);
				if (error instanceof Error && error.stack) {
					log.debug(error.stack);
				}
				throw error;
			}
		}
	};
}

/**
 * @param {{
 * 	dataPath: string,
 * 	urlPrefix: string,
 * 	databaseFilename?: string,
 * 	ducklakeDataPath?: string
 * }} options
 */
export async function createDuckLakeBackend({
	dataPath,
	urlPrefix,
	databaseFilename = 'evidence.ducklake',
	ducklakeDataPath
}) {
	const catalogFilepath = path.join(dataPath, databaseFilename);
	const localDuckLakeDataPath = ducklakeDataPath
		? path.resolve(ducklakeDataPath)
		: path.join(dataPath, `${databaseFilename}.data`);
	const remoteUrlPrefix = resolveDuckLakeRemoteUrlPrefix(urlPrefix);
	const remoteDuckLakeDataPath = joinUrlPath(
		remoteUrlPrefix,
		path.basename(localDuckLakeDataPath)
	);

	const builder = await createDuckLakeBuilder({
		outputFilepath: catalogFilepath,
		localDataPath: localDuckLakeDataPath,
		remoteDataPath: remoteDuckLakeDataPath
	});

	return {
		name: 'ducklake',
		manifestBackend: 'ducklake',
		capabilities: {
			filteredBuilds: false,
			externalUrlTables: false
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
			const rowCount = await builder.writeTable(sourceName, tableName, columns, data, batchSize);
			return { rowCount };
		},

		async finalize() {
			const artifact = await builder.finalize();
			return {
				databaseFile: {
					name: artifact.filename,
					url: `${urlPrefix}/${artifact.filename}`
				}
			};
		}
	};
}

/**
 * Create a DuckLake backend reader for querying existing .ducklake files
 * @param {{
 * 	databaseFilePath: string
 * }} options
 */
export async function createDuckLakeBackendReader({ databaseFilePath }) {
	await loadNodeDependencies();
	/** @type {any} */
	let db;
	/** @type {any} */
	let connection;

	const initReadDB = async () => {
		if (db) return;
		const resolvedPath = databaseFilePath.match(/^[a-zA-Z]+:\/\//)
			? databaseFilePath
			: toDuckDBPath(path.resolve(databaseFilePath));
		db = await DuckDBInstance.create(':memory:', {
			access_mode: 'READ_ONLY',
			custom_user_agent: 'evidence-dev'
		});
		connection = await db.connect();
		await connection.run('SET ieee_floating_point_ops = false;');
		await connection.run('SET old_implicit_casting = true;');
		await loadDuckLakeExtension(connection);
		await connection.run(
			`ATTACH ${toSQLString(resolvedPath)} AS ${quoteIdentifier(DUCKLAKE_ATTACH_NAME)} (TYPE ducklake);`
		);
		await connection.run(`USE ${quoteIdentifier(DUCKLAKE_ATTACH_NAME)};`);
	};

	return {
		name: 'ducklake',

		/**
		 * Initialize the database for reading
		 * @returns {Promise<void>}
		 */
		async initReadDB() {
			await initReadDB();
		},

		/**
		 * Query the database
		 * @param {string} sql
		 * @returns {Promise<any>}
		 */
		async queryReadDB(sql) {
			if (!connection) await initReadDB();
			return connection.query(sql);
		},

		/**
		 * Get the connection for direct access
		 */
		getReadConnection() {
			return connection;
		},

		/**
		 * Close the connection
		 */
		async close() {
			if (connection) {
				try {
					connection.disconnectSync();
				} catch {}
			}
			if (db) {
				try {
					db.closeSync();
				} catch {}
			}
		}
	};
}