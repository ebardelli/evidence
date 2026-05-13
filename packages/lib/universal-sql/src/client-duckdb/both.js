import { Type } from 'apache-arrow';

/**
 * Gets the default open configuration for DuckDB.
 * @returns {Object}
 */
export function getDefaultOpenConfig() {
	return {
		query: {
			castBigIntToDouble: true,
			castTimestampToDate: true,
			castDecimalToDouble: true,
			castDurationToTime64: true
		}
	};
}

/**
 * Gets the SQL configuration queries that should be run after connection.
 * @returns {string[]}
 */
export function getConnectionConfigQueries() {
	return ['SET ieee_floating_point_ops = false;', 'SET old_implicit_casting = true;'];
}

/**
 * Converts an Apache Arrow type to an Evidence type.
 *
 * @param {import("apache-arrow").Type} type
 */
function apacheToEvidenceType(type) {
	switch (
		type.typeId // maybe just replace with `typeof`
	) {
		case Type.Date:
			return 'date';
		case Type.Float:
		case Type.Int:
			return 'number';
		case Type.Bool:
			return 'boolean';
		case Type.Dictionary:
		default:
			return 'string';
	}
}

/**
 * Converts an Apache Arrow table to a Javascript array.
 * @param {import("apache-arrow").Table} table
 * @returns {any[]}
 */
export function arrowTableToJSON(table) {
	if (table == null) return [];
	const arr = table.toArray();

	Object.defineProperty(arr, '_evidenceColumnTypes', {
		enumerable: false,
		value: table.schema.fields.map((field) => ({
			name: field.name,
			evidenceType: apacheToEvidenceType(field.type),
			typeFidelity: 'precise'
		}))
	});

	const date_cols = table.schema.fields.filter((field) => field.type.typeId === Type.Date);
	const list_cols = table.schema.fields.filter((field) => field.type.typeId === Type.List);

	for (const row of arr) {
		for (const col of date_cols) {
			row[col.name] = new Date(row[col.name]);
		}
		for (const col of list_cols) {
			row[col.name] = arrowVectorToJSON(row[col.name]);
		}
	}

	return arr;
}

/**
 * Converts an Apache Arrow vector to a Javascript array.
 * @param {import("apache-arrow").Vector} vector
 * @returns {any[]}
 */
function arrowVectorToJSON(vector) {
	if (vector == null) return [];
	const arr = vector.toArray();

	const date_cols = vector.type?.children?.filter((field) => field.type.typeId === Type.Date) ?? [];
	const list_cols = vector.type?.children?.filter((field) => field.type.typeId === Type.List) ?? [];

	for (const row of arr) {
		for (const col of date_cols) {
			row[col.name] = new Date(row[col.name]);
		}
		for (const col of list_cols) {
			row[col.name] = arrowVectorToJSON(row[col.name]);
		}
	}

	return arr;
}

/**
 * Creates a new Promise object and returns it along with its resolve and reject functions.
 *
 * @return {{resolve: CallableFunction, reject: CallableFunction, promise: Promise<void>}} An object containing the resolve and reject functions, as well as the Promise object.
 */
export function getPromise() {
	let resolve, reject;
	let promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

export function withTimeout(p) {
	return Promise.race([
		p,
		new Promise((_, rej) =>
			// If the database isn't initialized after 5 seconds, throw an error
			setTimeout(() => rej(new Error('Timeout while initializing database')), 5000)
		)
	]);
}

/**
 * @param {any} connection
 * @param {string} sql
 */
async function queryExternalConnection(connection, sql) {
	if (!connection) throw new Error('External connection is not initialized');
	if (typeof connection.query === 'function') {
		return await connection.query(sql);
	}
	if (typeof connection.runAndReadAll === 'function') {
		const reader = await connection.runAndReadAll(sql);
		if (typeof reader?.readAll === 'function') {
			await reader.readAll();
		}
		if (typeof reader?.getRowObjectsJS === 'function') {
			return reader.getRowObjectsJS();
		}
		return [];
	}
	if (typeof connection.run === 'function') {
		await connection.run(sql);
		return [];
	}
	throw new Error('External connection does not expose query method');
}

/**
 * @param {Object} context
 */
async function closeExternalConnection(context) {
	if (context.externalConnectionRef?.current?.close) {
		try {
			await context.externalConnectionRef.current.close();
		} catch {}
	}
}

/**
 * @param {Object} context
 */
async function clearExternalConnection(context) {
	await closeExternalConnection(context);
	if (context.externalConnectionRef) context.externalConnectionRef.current = null;
}

/**
 * @param {Object} context
 * @param {string} pathOrUrl
 * @param {{ onConnected?: () => void | Promise<void> }} [options]
 */
async function connectExternalIfAvailable(context, pathOrUrl, options = {}) {
	if (typeof context.createExternalConnection !== 'function') return false;
	// Normalize separators and leading slashes so equivalent local paths match.
	const normalizePathIdentity = (value) =>
		String(value ?? '')
			.split(/[\\/]/)
			.join('/')
			.replace(/^\/+/, '');
	const targetPath = normalizePathIdentity(pathOrUrl);
	const currentConnection = context.externalConnectionRef?.current;
	if (
		currentConnection &&
		normalizePathIdentity(currentConnection.sourcePath) === targetPath
	) {
		// Reuse existing external connection when targeting the same source.
		if (typeof options.onConnected === 'function') {
			await options.onConnected();
		}
		return true;
	}
	const externalConnection = await context.createExternalConnection(pathOrUrl);
	if (!externalConnection) return false;
	// Different source (or first connect): replace previous external connection.
	await closeExternalConnection(context);
	context.externalConnectionRef.current = externalConnection;
	if (typeof options.onConnected === 'function') {
		await options.onConnected();
	}
	return true;
}

/**
 * @param {{ path?: string, url?: string }} databaseFile
 */
function getManifestDatabasePath(databaseFile) {
	return databaseFile?.path ?? databaseFile?.url;
}

/**
 * @param {Object} context
 * @param {{
 * 	databaseFile?: { path?: string, url?: string },
 * 	renderedFiles?: Record<string, string[]>,
 * 	locatedSchemas?: string[]
 * }} manifest
 * @param {{ addBasePath?: (path: string) => string }} [opts]
 */
async function initializeBackendFromManifest(context, manifest = {}, { addBasePath = (x) => x } = {}) {
	await context.initDB();
	const databasePath = getManifestDatabasePath(manifest.databaseFile);
	if (databasePath) {
		await context.backend.loadDuckDBDatabase(databasePath, { addBasePath });
		await context.backend.updateSearchPath(manifest.locatedSchemas ?? []);
		return;
	}
	const renderedFiles = manifest.renderedFiles ?? {};
	await context.backend.setParquetURLs(renderedFiles, { addBasePath });
	await context.backend.updateSearchPath(Object.keys(renderedFiles));
}

/**
 * @param {string[] | unknown} schemas
 */
function normalizeSchemas(schemas) {
	return Array.isArray(schemas) ? schemas.map((s) => String(s)).filter(Boolean) : [];
}

/**
 * @param {string[] | unknown} schemas
 */
function buildSearchPath(schemas) {
	return ['main', ...normalizeSchemas(schemas)].join(',');
}

/**
 * @param {Record<string, unknown>[]} rows
 */
function buildDerivedSearchPath(rows) {
	const schemas = rows.map((r) => String(r.table_schema)).filter(Boolean);
	return buildSearchPath(schemas);
}

/**
 * @param {string} pathOrUrl
 */
function isDuckLakePath(pathOrUrl) {
	return /\.ducklake(?:$|\?|#)/i.test(pathOrUrl);
}

/**
 * @param {string} value
 */
function toSQLString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {string} pathOrUrl
 */
function toAbsoluteHttpUrl(pathOrUrl) {
	if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
	if (typeof window !== 'undefined' && window.location?.origin && pathOrUrl.startsWith('/')) {
		return `${window.location.origin}${pathOrUrl}`;
	}
	return pathOrUrl;
}

/**
 * @param {unknown} error
 */
function isMissingTableError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /Catalog Error: Table with name .* does not exist!/i.test(message);
}

/**
 * @param {unknown} error
 */
function isMissingSearchPathSchemaError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /SET search_path:\s+No catalog\s*\+\s*schema named/i.test(message);
}

/**
 * @param {unknown} result
 */
function normalizeQueryRows(result) {
	if (Array.isArray(result)) return result;
	try {
		return arrowTableToJSON(result);
	} catch {
		return [];
	}
}

/**
 * @param {Object} context
 * @param {string[] | unknown} schemas
 * @param {(sql: string) => unknown | Promise<unknown>} runSearchPathQuery
 */
async function updateSearchPath(context, schemas, runSearchPathQuery) {
	const requestedSchemas = normalizeSchemas(schemas);
	const runQuery = context.externalConnectionRef?.current
		? (sql) => queryExternalConnection(context.externalConnectionRef.current, sql)
		: runSearchPathQuery;

	const applySearchPath = async (targetSchemas) => {
		const searchPath = buildSearchPath(targetSchemas);
		await runQuery(`PRAGMA search_path='${searchPath}'`);
	};

	let initialSearchPathError;
	try {
		await applySearchPath(requestedSchemas);
		return;
	} catch (error) {
		initialSearchPathError = error;
		if (!requestedSchemas.length) throw error;
	}

	let existingSchemas = [];
	try {
		const schemaRows = await runQuery(`
			SELECT DISTINCT table_schema
			FROM information_schema.tables
			WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'main', 'temp')
			ORDER BY table_schema
		`);
		existingSchemas = normalizeQueryRows(schemaRows)
			.map((row) => String(row?.table_schema ?? '').trim())
			.filter(Boolean);
	} catch {
		// If schema introspection fails, fall back to main only.
	}

	const existingSchemaSet = new Set(existingSchemas);
	const filteredSchemas = requestedSchemas.filter((schema) => existingSchemaSet.has(schema));

	try {
		await applySearchPath(filteredSchemas);
	} catch (fallbackError) {
		if (isMissingSearchPathSchemaError(initialSearchPathError)) throw fallbackError;
		throw initialSearchPathError;
	}
}

/**
 * Creates a backend factory for Node.js environment.
 * @param {Object} context - Contains db, connection refs and dependencies
 * @returns {Object}
 */
export function createNodeBackendFactory(context) {
	// Helper functions scoped to this backend
	function configureConnection() {
		context.connectionRef.current = context.db.connect();
		const configQueries = getConnectionConfigQueries();
		for (const query of configQueries) {
			context.connectionRef.current.query(query);
		}
	}

	function reopenDatabase(config, { reset = true } = {}) {
		if (!context.db) throw new Error('DuckDB has not been instantiated');
		if (reset && typeof context.db.reset === 'function') {
			context.db.reset();
		}
		context.db.open(config);
		configureConnection();
	}

	function applyDerivedSearchPath() {
		const result = context.connectionRef.current.query(`
			SELECT DISTINCT table_schema
			FROM information_schema.tables
			WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'main', 'temp')
			ORDER BY table_schema
		`);
		const rows = arrowTableToJSON(result);
		const searchPath = buildDerivedSearchPath(rows);
		context.connectionRef.current.query(`PRAGMA search_path='${searchPath}'`);
		return true;
	}

	return {
		name: 'node',
		getDefaultConfig: getDefaultOpenConfig,
		getConfigQueries: getConnectionConfigQueries,
		configureConnection,
		reopenDatabase,
		applyDerivedSearchPath,
		updateSearchPath: async (schemas) => {
			if (!context.connectionRef.current) await context.initDB();
			return updateSearchPath(context, schemas, (sql) => context.connectionRef.current.query(sql));
		},
		emptyDbFs: async (targetGlob) => {
			await context.db.flushFiles();
			for (const f of context.db.globFiles(targetGlob)) {
				await context.db.dropFile(f.fileName);
			}
		},
		setParquetURLs: async (urls, options = false) => {
			const append = typeof options === 'boolean' ? options : Boolean(options?.append);
			if (!append) await context.backend.emptyDbFs('*');
			if (process.env.VITE_EVIDENCE_DEBUG) console.log(`Updating Parquet URLs`);
			for (const source in urls) {
				context.connectionRef.current.query(`CREATE SCHEMA IF NOT EXISTS "${source}";`);
				for (const url of urls[source]) {
					const table = url.split(/[\\/]/).at(-1).slice(0, -'.parquet'.length);
					const file_name = `${source}_${table}.parquet`;
					if (append) {
						await context.backend.emptyDbFs(file_name);
						await context.backend.emptyDbFs(url);
					}
					context.db.registerFileURL(
						file_name,
						url.split(/[\\/]/).join(context.pathSep),
						context.DuckDBDataProtocol.NODE_FS,
						false
					);
					context.connectionRef.current.query(
						`CREATE OR REPLACE VIEW "${source}"."${table}" AS (SELECT * FROM read_parquet('${file_name}'));`
					);
				}
			}
		},
		loadDuckDBDatabase: async (filePath, { addBasePath = (x) => x } = {}) => {
			if (!context.db) await context.initDB();
			if (isDuckLakePath(filePath)) {
				if (await connectExternalIfAvailable(context, filePath)) return;
				await clearExternalConnection(context);
				await reopenDatabase(
					{
						...context.defaultOpenConfig,
						accessMode: context.DuckDBAccessMode.READ_WRITE
					},
					{ reset: true }
				);

				const normalizedPath = filePath.split(/[\\/]/).join(context.pathSep);
				const pathCandidates = [normalizedPath];
				const addRelativeCandidates = (candidatePath) => {
					pathCandidates.push(context.resolvePath(context.cwd(), candidatePath));
					pathCandidates.push(context.resolvePath(context.cwd(), '.evidence', candidatePath));
					pathCandidates.push(
						context.resolvePath(context.cwd(), '.evidence', 'template', candidatePath)
					);
				};

				if (!context.isAbsolutePath(normalizedPath)) {
					addRelativeCandidates(normalizedPath);
				} else {
					const relativeLikePath = normalizedPath.replace(
						new RegExp(`^\\${context.pathSep}+`),
						''
					);
					if (relativeLikePath && relativeLikePath !== normalizedPath) {
						addRelativeCandidates(relativeLikePath);
					}
				}

				const uniqueCandidates = [...new Set(pathCandidates)];
				const resolvedPath = uniqueCandidates.find((candidatePath) => context.existsSync(candidatePath));
				if (!resolvedPath) {
					throw new Error(
						`DuckLake catalog file not found for ${filePath}. Tried: ${uniqueCandidates.join(', ')}`
					);
				}
				const absoluteResolvedPath = context.isAbsolutePath(resolvedPath)
					? resolvedPath
					: context.resolvePath(context.cwd(), resolvedPath);
				const catalogFileName = context.getBasename(absoluteResolvedPath) || 'evidence.ducklake';
				const catalogFileBuffer = new Uint8Array(context.readFileSync(absoluteResolvedPath));
				context.db.registerFileBuffer(catalogFileName, catalogFileBuffer);
				const ducklakeDataPath = absoluteResolvedPath.replace(
					/\.ducklake(?:\?.*|#.*)?$/i,
					'.ducklake.data'
				);
				const attachName = 'evidence_ducklake';
				try {
					await context.connectionRef.current.query('INSTALL ducklake;');
				} catch {}
				await context.connectionRef.current.query('LOAD ducklake;');
				await context.connectionRef.current.query(
					`ATTACH ${toSQLString(catalogFileName)} AS "${attachName}" (TYPE ducklake, DATA_PATH ${toSQLString(ducklakeDataPath)}, OVERRIDE_DATA_PATH true, READ_ONLY);`
				);
				await context.connectionRef.current.query(`USE "${attachName}";`);
				return;
			}

			if (await connectExternalIfAvailable(context, filePath)) return;
			await clearExternalConnection(context);
			const normalizedPath = filePath.split(/[\\/]/).join(context.pathSep);
			const pathCandidates = [normalizedPath];
			const addRelativeCandidates = (candidatePath) => {
				pathCandidates.push(context.resolvePath(context.cwd(), candidatePath));
				pathCandidates.push(context.resolvePath(context.cwd(), '.evidence', candidatePath));
				pathCandidates.push(
					context.resolvePath(context.cwd(), '.evidence', 'template', candidatePath)
				);
			};

			if (!context.isAbsolutePath(normalizedPath)) {
				addRelativeCandidates(normalizedPath);
			} else {
				const relativeLikePath = normalizedPath.replace(new RegExp(`^\\${context.pathSep}+`), '');
				if (relativeLikePath && relativeLikePath !== normalizedPath) {
					addRelativeCandidates(relativeLikePath);
				}
			}

			const uniqueCandidates = [...new Set(pathCandidates)];
			const resolvedPath =
				uniqueCandidates.find((candidatePath) => context.existsSync(candidatePath)) ??
				uniqueCandidates[uniqueCandidates.length - 1];
			const absoluteResolvedPath = context.isAbsolutePath(resolvedPath)
				? resolvedPath
				: context.resolvePath(context.cwd(), resolvedPath);
			const dbFileName = context.getBasename(absoluteResolvedPath) || 'evidence.duckdb';
			const fileBuffer = new Uint8Array(context.readFileSync(absoluteResolvedPath));
			if (typeof context.db.reset === 'function') context.db.reset();
			context.db.registerFileBuffer(dbFileName, fileBuffer);
			reopenDatabase(
				{
					...context.defaultOpenConfig,
					path: dbFileName,
					accessMode: context.DuckDBAccessMode.READ_ONLY
				},
				{ reset: false }
			);
		},
		initializeFromManifest: async (manifest = {}, { addBasePath = (x) => x } = {}) => {
			return initializeBackendFromManifest(context, manifest, { addBasePath });
		},
		query: (sql, cache_options) => {
			if (context.externalConnectionRef?.current) {
				const externalResult = queryExternalConnection(context.externalConnectionRef.current, sql);
				if (
					externalResult &&
					typeof externalResult.then === 'function' &&
					typeof context.registerPendingQuery === 'function'
				) {
					context.registerPendingQuery(externalResult);
				}
				return externalResult;
			}
			const cacheResult = (value) => {
				if (!cache_options) return;
				try {
					context.cache_for_hash(sql, value, cache_options);
				} catch (cacheError) {
					try {
						context.cache_for_hash(sql, undefined, cache_options);
					} catch {}
					console.warn(
						`Failed to cache query result for ${cache_options.query_name}: ${
							cacheError instanceof Error ? cacheError.message : String(cacheError)
						}`
					);
				}
			};
			let result;
			if (cache_options?.prerendering) {
				result = context.get_arrow_if_sql_already_run(sql);
			}
			if (!result) {
				try {
					result = context.connectionRef.current.query(sql);
				} catch (e) {
					if (!isMissingTableError(e)) throw e;
					const recovered = applyDerivedSearchPath();
					if (!recovered) throw e;
					result = context.connectionRef.current.query(sql);
				}
			}
			if (cache_options) {
				cacheResult(result);
			}
			return arrowTableToJSON(result);
		}
	};
}

/**
 * Creates a backend factory for browser environment.
 * @param {Object} context - Contains db, connection refs and dependencies
 * @returns {Object}
 */
export function createBrowserBackendFactory(context) {
	// Helper functions scoped to this backend
	async function configureConnection() {
		context.connectionRef.current = await context.db.connect();
		const configQueries = getConnectionConfigQueries();
		for (const query of configQueries) {
			await context.connectionRef.current.query(query);
		}
	}

	async function reopenDatabase(config, { reset = true } = {}) {
		if (!context.db) await context.initDB();
		if (reset && typeof context.db.reset === 'function') {
			await context.db.reset();
		}
		await context.db.open(config);
		await configureConnection();
	}

	async function applyDerivedSearchPath() {
		const result = await context.connectionRef.current.query(`
			SELECT DISTINCT table_schema
			FROM information_schema.tables
			WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'main', 'temp')
			ORDER BY table_schema
		`);
		const rows = arrowTableToJSON(result);
		const searchPath = buildDerivedSearchPath(rows);
		await context.connectionRef.current.query(`PRAGMA search_path='${searchPath}'`);
		return true;
	}

	return {
		name: 'browser',
		getDefaultConfig: getDefaultOpenConfig,
		getConfigQueries: getConnectionConfigQueries,
		configureConnection,
		reopenDatabase,
		applyDerivedSearchPath,
		updateSearchPath: async (schemas) => {
			if (!context.db) await context.initDB();
			return updateSearchPath(context, schemas, (sql) => context.connectionRef.current.query(sql));
		},
		emptyDbFs: async (targetGlob) => {
			await context.db.flushFiles();
			for (const f of await context.db.globFiles(targetGlob)) {
				await context.db.dropFile(f.fileName);
			}
		},
		setParquetURLs: async (urls, { append, addBasePath = (x) => x } = {}) => {
			if (!context.db) await context.initDB();
			if (!append) await context.backend.emptyDbFs('*');
			if (import.meta.env.VITE_EVIDENCE_DEBUG) console.debug('Updating Parquet URLs');
			try {
				for (const source in urls) {
					await context.connectionRef.current.query(`CREATE SCHEMA IF NOT EXISTS "${source}";`);
					for (const url of urls[source]) {
						const table = url.split(/[\\/]/).at(-1).slice(0, -'.parquet'.length);
						const file_name = `${source}_${table}.parquet`;
						let path = url;
						if (!url.startsWith('http') && !url.startsWith('/')) {
							path = `/${url}`;
						}
						if (path.startsWith('/static')) path = path.substring(7);
						if (append) {
							await context.backend.emptyDbFs(file_name);
							await context.backend.emptyDbFs(url);
						}
						await context.db.registerFileURL(
							file_name,
							addBasePath(path),
							context.DuckDBDataProtocol.HTTP,
							false
						);
						await context.connectionRef.current.query(
							`CREATE OR REPLACE VIEW "${source}"."${table}" AS (SELECT * FROM read_parquet('${file_name}'));`
						);
					}
				}
				context.resolveTables();
			} catch (e) {
				context.rejectTables(e);
				console.error(`Error encountered while updating Parquet URLs`, e);
				throw e;
			}
		},
		loadDuckDBDatabase: async (url, { addBasePath = (x) => x } = {}) => {
			if (!context.db) await context.initDB();
			if (
				await connectExternalIfAvailable(context, url, {
					onConnected: () => context.resolveTables()
				})
			)
				return;
			await clearExternalConnection(context);
			const fileName = url.split(/[\\/]/).at(-1) ?? 'evidence.duckdb';
			let path = url;
			if (!url.startsWith('http') && !url.startsWith('/')) {
				path = `/${url}`;
			}
			if (path.startsWith('/static')) path = path.substring(7);

			if (isDuckLakePath(url)) {
				await reopenDatabase(
					{
						...context.defaultOpenConfig,
						accessMode: context.DuckDBAccessMode.READ_WRITE
					},
					{ reset: true }
				);

				const resolvedPath = toAbsoluteHttpUrl(addBasePath(path));
				const ducklakeDataPath = resolvedPath.replace(
					/\.ducklake(?:\?.*|#.*)?$/i,
					'.ducklake.data'
				);
				const attachName = 'evidence_ducklake';
				try {
					await context.connectionRef.current.query('INSTALL ducklake;');
				} catch {}
				await context.connectionRef.current.query('LOAD ducklake;');
				await context.connectionRef.current.query(
					`ATTACH ${toSQLString(resolvedPath)} AS "${attachName}" (TYPE ducklake, DATA_PATH ${toSQLString(ducklakeDataPath)}, OVERRIDE_DATA_PATH true, READ_ONLY);`
				);
				await context.connectionRef.current.query(`USE "${attachName}";`);
				context.resolveTables();
				return;
			}

			await context.db.registerFileURL(
				fileName,
				addBasePath(path),
				context.DuckDBDataProtocol.HTTP,
				false
			);
			await reopenDatabase(
				{
					...context.defaultOpenConfig,
					path: fileName,
					accessMode: context.DuckDBAccessMode.READ_ONLY
				},
				{ reset: true }
			);
			context.resolveTables();
		},
		initializeFromManifest: async (manifest = {}, { addBasePath = (x) => x } = {}) => {
			return initializeBackendFromManifest(context, manifest, { addBasePath });
		},
		query: async (sql) => {
			if (context.externalConnectionRef?.current) {
				return queryExternalConnection(context.externalConnectionRef.current, sql);
			}
			if (!context.db) await context.initDB();
			await withTimeout(context.tablesPromise);
			let res;
			try {
				res = await context.connectionRef.current.query(sql).then(arrowTableToJSON);
			} catch (e) {
				if (!isMissingTableError(e)) throw e;
				const recovered = await applyDerivedSearchPath();
				if (!recovered) throw e;
				res = await context.connectionRef.current.query(sql).then(arrowTableToJSON);
			}
			return res;
		}
	};
}
