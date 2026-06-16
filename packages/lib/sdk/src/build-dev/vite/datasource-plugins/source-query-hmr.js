import path from 'path';
import { evalSources } from '../../../plugins/datasources/evalSources.js';
import { dataDirectory, metaDirectory, sourcesDirectory } from '../../../lib/projectPaths.js';
import { updateManifest } from '../../../plugins/datasources/updateManifest.js';
import { ProcessingQueue } from '../../../lib/processing-queue.js';
import { VITE_EVENTS } from '../constants.js';
import { debounce } from 'perfect-debounce';
import { getEvidenceConfig } from '../../../configuration/getEvidenceConfig.js';
import { getStorageBackendHmrHandler } from '@evidence-dev/universal-sql';
/**
 * @returns {import("vite").Plugin}
 */
export const sourceQueryHmr = () => {
	const processingQueue = ProcessingQueue();
	const configStorageMode =
		/** @type {any} */ (getEvidenceConfig().buildOptions)?.storageMode ?? 'parquet';
	const handleBackendHmr = getStorageBackendHmrHandler(configStorageMode);
	const supportsFilteredBuilds =
		configStorageMode === 'parquet' ||
		configStorageMode === 'ducklake' ||
		configStorageMode === 'duckdb';

	/** @type {import('vite').ViteDevServer | undefined} */
	let server;

	/** @type {import('../../../plugins/datasources/types.js').Manifest | undefined} */
	let latestManifest;

	/**
	 * @param {string | null} datasource
	 * @param {string | null} table
	 */
	const processSource = (datasource, table) => async () => {
		const resolvedDatasource = supportsFilteredBuilds ? datasource : null;
		const resolvedTable = supportsFilteredBuilds ? table : null;
		const targetLabel = resolvedDatasource
			? resolvedTable
				? `${resolvedDatasource}.${resolvedTable}`
				: `${resolvedDatasource}.*`
			: 'all sources';

		if (!server) {
			console.warn('missing ref to dev server');
			return;
		}
		server.hot.send(VITE_EVENTS.SOURCE_START, {
			id: targetLabel,
			toast: {
				id: targetLabel,
				status: 'info',
				message: `Loading ${targetLabel}`
			}
		});

		try {
			const filterOptions = {
				sources: resolvedDatasource ? new Set([resolvedDatasource]) : null,
				queries: resolvedTable ? new Set([resolvedTable]) : null,
				only_changed: false
			};

			const updatedManifest = await evalSources(dataDirectory, metaDirectory, filterOptions, true);
			latestManifest = await updateManifest(updatedManifest, dataDirectory);

			server?.hot.send(VITE_EVENTS.SOURCE_END, {
				id: `${targetLabel}-end`,
				toast: {
					id: targetLabel,
					status: 'success',
					message: `Finished ${targetLabel}`
				}
			});
		} catch (e) {
			server?.hot.send(VITE_EVENTS.SOURCE_ERROR, {
				error: e instanceof Error ? e.message : e,
				toast: {
					id: targetLabel,
					status: 'error',
					message: `Failed to process ${targetLabel}`
				}
			});
		}
	};

	const queueOptions = debounce(
		/**
		 * Whenever sources are saved, the connection.options.yaml file and the connection.yaml file are written
		 * Because we are using a file-watch, this would double up the executions, so we debounce them to prevent that
		 * @param {string} sourceName
		 */
		(sourceName) => {
			processingQueue.add(processSource(sourceName, null));
		},
		50
	);

	/**
	 * @param {string} sourceName
	 */
	const queueSourceReload = (sourceName) => {
		processingQueue.add(processSource(sourceName, null));
	};

	/**
	 * @param {string} sourceName
	 * @param {string} tableName
	 */
	const queueQueryReload = (sourceName, tableName) => {
		processingQueue.add(processSource(sourceName, tableName));
	};

	/** @type {import("vite").Plugin} */
	return {
		name: 'evidence:source-query-hmr',
		buildStart: function () {
			if (this.meta.watchMode) {
				this.addWatchFile(sourcesDirectory);
			}
		},
		configureServer: (s) => {
			server = s;
			processingQueue.addListener('done', () => {
				s.hot.send(VITE_EVENTS.RESET_QUERIES, { latestManifest });
			});
		},
		/** @type {import("vite").Plugin['watchChange']} */
		watchChange: async function (id) {
			const changed = path.resolve(id);
			if (!changed.startsWith(sourcesDirectory)) return; // don't care

			const parts = changed.replace(sourcesDirectory, '').split(path.sep);
			const sourceName = parts.at(1);
			const queryName = path.basename(changed).split('.').at(0);
			if (!sourceName || !queryName) {
				console.warn(
					`Failed to HMR source query at ${changed}, could not identify source or query name`
				);
				return;
			}

			handleBackendHmr({
				sourceName,
				tableName: queryName,
				queueConnectionReload: queueOptions,
				queueQueryReload,
				queueSourceReload,
				warn: (message) => {
					console.warn(message);
				}
			});
		}
	};
};
