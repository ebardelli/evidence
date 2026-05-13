import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

import { EvidenceError } from '../../lib/EvidenceError.js';
import { loadSourcePlugins } from './loadSourcePlugins.js';
import { loadSources } from './loadSources.js';
import { wrapSimpleConnector } from './wrapSimpleConnector.js';
import { createStorageBackend } from '@evidence-dev/universal-sql';
import { buildSourceDirectoryProxy } from './buildSourceDirectoryProxy.js';
import { addToCache, checkCache, flushCache, loadCache } from './SourceResultCache.js';
import ora from 'ora';
import { dataUrlPrefix } from '../../lib/projectPaths.js';
import { subSourceVariables } from './sub-source-vars.js';
import { logQueryEvent } from '@evidence-dev/telemetry';

// TODO: This is a great candidate for unit testing - but it may need to be broken down further to make that more achievable, right now it would take a _lot_ of mocks

/**
 * @param {string} dataPath
 * @param {string} metaPath
 * @param {import('./types.js').SourceFilters} [filters] `sources` or `queries` being null means no filter
 * @param {boolean} [strict]
 * @returns {Promise<import('./types.js').Manifest>}
 */
export const evalSources = async (dataPath, metaPath, filters, strict) => {
	const pluginLoader = ora({ text: 'Loading plugins & sources' }).start();

	// Setup work
	const [sourcePlugins, sources] = await Promise.all([
		loadSourcePlugins(),
		loadSources(pluginLoader),
		loadCache(metaPath)
	]).catch((e) => {
		pluginLoader.fail();
		throw e;
	});

	if (sources.length) {
		pluginLoader.succeed();
	}

	// Determine storage mode from first source
	const storageMode =
		sources.length > 0 ? (sources[0].buildOptions?.storageMode ?? 'parquet') : 'parquet';

	// Validate all sources use same storage mode
	for (const source of sources) {
		const sourceStorageMode = source.buildOptions?.storageMode ?? 'parquet';
		if (storageMode !== sourceStorageMode) {
			throw new EvidenceError(
				'Mixed datasource storage modes are not currently supported. Please use a single buildOptions.storageMode across all sources.'
			);
		}
	}

	/** @type {import('./types.js').Manifest} */
	const outputManifest = {
		renderedFiles: {},
		locatedFiles: {},
		locatedSchemas: []
	};

	/** @type {any} */
	const databaseFilenameByStorageMode = {
		duckdb: 'evidence.duckdb',
		ducklake: 'evidence.ducklake'
	};

	/** @type {any} */
	const storageBackend =
		sources.length > 0
			? await createStorageBackend(storageMode, {
					dataPath,
					metaPath,
					urlPrefix: dataUrlPrefix ?? '',
					databaseFilename: databaseFilenameByStorageMode[storageMode] ?? 'evidence.duckdb',
					database: sources[0].buildOptions?.database,
					token: sources[0].buildOptions?.token,
					readScalingToken: sources[0].buildOptions?.readScalingToken
				})
			: null;

	if (storageBackend?.manifestBackend) {
		outputManifest.backend = storageBackend.manifestBackend;
	}

	/** @type {string[]} */
	const skippedSources = [];

	for (const source of sources) {
		if (
			storageBackend &&
			!storageBackend.capabilities.filteredBuilds &&
			((filters?.sources && filters.sources.size > 0) ||
				(filters?.queries && filters.queries.size > 0) ||
				filters?.only_changed)
		) {
			throw new EvidenceError(
				`${storageBackend.name} storage mode does not yet support filtered or incremental source builds. Please run a full sources build.`
			);
		}

		outputManifest.locatedSchemas ??= [];
		outputManifest.locatedSchemas.push(source.name);
		if (filters?.sources?.size && !filters?.sources?.has(source.name)) {
			console.debug(`  [Skipping]: ${chalk.bold(source.name)}`);
			skippedSources.push(source.name);
			continue;
		} else {
			console.log(chalk.dim('-'.repeat(5)));
			console.log(chalk.green(`  [Processing] ${chalk.bold(source.name)}`));
		}

		const plugin = sourcePlugins.getBySource(source.type);
		if (!plugin) {
			logQueryEvent('source-connector-not-found', source.type, source.name);
			// TODO: How forgiving do we want to be here?
			// TODO: If we want to be really fancy; we could batch these, and do an NPM lookup at the end to say "these packages provide those datasources"
			throw new EvidenceError(
				`Could not find matching datasource plugin for ${chalk.bold(
					source.name
				)} (source: ${chalk.bold(source.type)})`
			);
		}
		const [, mod] = plugin;
		const testResult = await mod.testConnection(source.options, source.dir);
		if (testResult !== true) {
			logQueryEvent('db-connection-error', source.type, source.name);
			throw new EvidenceError(
				`Error connecting to datasource ${chalk.bold(source.name)}: ${testResult.reason}`
			);
		} else {
			logQueryEvent('db-connection-success', source.type, source.name);
		}

		/** @type {import('./types.js').ProcessSourceFn} */
		const tableIter = 'processSource' in mod ? mod.processSource : wrapSimpleConnector(mod, source);

		const utils = buildUtils(source, filters);

		outputManifest.renderedFiles[source.name] = [];
		if (!outputManifest.locatedFiles) outputManifest.locatedFiles = {};
		outputManifest.locatedFiles[source.name] = [];

		const iter = tableIter(source.options, await buildSourceDirectoryProxy(source.dir), utils)[
			Symbol.asyncIterator
		](); // this is required for typescript to be happy

		/** @type {IteratorResult<import('./types.js').QueryResultTable<any> | EvidenceError>} */
		let iterResult;

		while (((iterResult = await iter.next()), !iterResult.done)) {
			if (iterResult.done) continue;
			if (iterResult.value instanceof Error) {
				const error = iterResult.value;
				let tableName = 'Unknown';
				if (error instanceof EvidenceError) {
					if (error.metadata.tableName) tableName = error.metadata.tableName;
				}
				ora({
					prefixText: `  ${tableName}`,
					spinner: 'triangle',
					discardStdin: false,
					interval: 250
				}).fail(`Error: ${error.message}`);
				logQueryEvent('db-error', source.type, source.name, tableName);
				if (strict) throw error;
				continue;
			}
			const table = { ...iterResult.value };
			const locatedTables = outputManifest.locatedFiles[source.name];
			const markTableLocated = () => {
				if (!locatedTables.includes(table.name)) {
					locatedTables.push(table.name);
				}
			};
			const spinner = ora({
				prefixText: `  ${table.name}`,
				spinner: 'triangle',
				discardStdin: false,
				interval: 250
			});

			if (!storageBackend?.manifestBackend) {
				markTableLocated();
			}
			spinner.start('Processing...');
			if (utils.isFiltered(table.name)) {
				markTableLocated();
				spinner.info('Skipped');
				continue;
			}
			if (utils.isCached(table.name, table.content)) {
				markTableLocated();
				spinner.info('From Cache');
				logQueryEvent('cache-query', source.type, source.name);
				continue;
			}
			logQueryEvent('db-query', source.type, source.name, table.name);

			if ('url' in table) {
				if (!storageBackend?.capabilities.externalUrlTables) {
					throw new EvidenceError(
						`Source ${source.name}.${table.name} exposes an external URL result, which is not yet supported in ${storageBackend?.name ?? 'this'} storage mode.`
					);
				}
				markTableLocated();
				outputManifest.renderedFiles[source.name].push(table.url);
				continue;
			}
			try {
				if (!table.rows) {
					spinner.warn('No results returned.');
					continue;
				}
				if (!storageBackend) {
					throw new EvidenceError('Storage backend was not initialized');
				}

				/** @type {any} */
				const writeResult = await storageBackend.writeTable({
					sourceName: source.name,
					tableName: table.name,
					columns: table.columnTypes,
					data: table.rows,
					batchSize: source.buildOptions?.batchSize
				});

				const writtenRows = writeResult.rowCount;
				if (writeResult.renderedFile) {
					outputManifest.renderedFiles[source.name].push(writeResult.renderedFile);
				}

				addToCache(source.name, table.name, table.content);
				markTableLocated();

				spinner.succeed(`Finished, wrote ${writtenRows} rows.`);
			} catch (e) {
				if (e instanceof Error) {
					console.error(e.stack);
					spinner.fail(e.message);
				} else {
					spinner.fail('Unknown Error Encountered');
				}
				if (e instanceof EvidenceError && e.context) {
					if (Array.isArray(e.context)) console.warn(chalk.dim('    ' + e.context.join('\n    ')));
					else console.warn(chalk.dim('    ' + e.context));
				}
				console.debug();
				if (e instanceof Error)
					console.debug(chalk.dim('    ' + e.stack?.split('\n').join('\n    ')));
				else console.debug(chalk.dim(e));

				if (strict) {
					throw e;
				}
			}
		}
	}
	console.log(chalk.dim('-'.repeat(5)));

	if (storageBackend) {
		const artifact = await storageBackend.finalize();
		if (artifact.databaseFile) {
			outputManifest.databaseFile = artifact.databaseFile;
		}
	}

	if (skippedSources.length)
		console.log(
			chalk.dim(
				`  ${skippedSources.length} source${skippedSources.length === 1 ? '' : 's'} were not run due to filters`
			)
		);

	await flushCache(metaPath);

	return outputManifest;
};

/**
 *
 * @param {Awaited<ReturnType<typeof loadSources>>[number]} source
 * @param {import('./types.js').SourceFilters} [filters]
 * @returns {import('./types.js').SourceUtils}
 */
const buildUtils = (source, filters) => {
	/** @type {import('./types.js').SourceUtils} */
	const utils = {
		/**
		 * @param {string} name
		 * @param {string} content
		 */
		isCached: (name, content) =>
			Boolean(filters?.only_changed && checkCache(source.name, name, content)),
		/**
		 * @param {string} name
		 * @returns {boolean} true if query is included in filters
		 */
		isFiltered: (name) => {
			if (!filters?.queries?.size) return false;
			return Boolean(!filters.queries.has(name) && !filters.queries.has(`${source.name}.${name}`));
		},
		/**
		 * @param {string} name
		 * @param {string} content
		 * @returns {boolean}
		 */
		shouldRun: (name, content) => !utils.isFiltered(name) && !utils.isCached(name, content),
		/**
		 * @param {string} name
		 * @param {string} content
		 */
		addToCache: (name, content) => addToCache(source.name, name, content),
		subSourceVariables: subSourceVariables,
		escape: (tableName, tableContent) => ({
			name: tableName,
			content: tableContent,
			rows: [],
			columnTypes: []
		})
	};

	return utils;
};
