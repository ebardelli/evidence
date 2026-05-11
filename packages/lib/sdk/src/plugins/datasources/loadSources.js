import path from 'path';
import fs from 'fs/promises';
import chalk from 'chalk';
import { loadSourceConfig } from './loadSourceConfig.js';
import { sourcesDirectory } from '../../lib/projectPaths.js';
import { getEvidenceConfig } from '../../configuration/getEvidenceConfig.js';

/**
 *
 * @param {string} sourcePath
 */
const loadSource = async (sourcePath) => {
	const isDir = await fs.stat(sourcePath).then((stat) => stat.isDirectory());
	if (!isDir) {
		console.debug(
			chalk.dim.yellow(`Source @ ${path.relative(process.cwd(), sourcePath)} is not a directory!`)
		);
		return false;
	}
	return loadSourceConfig(sourcePath);
};

/**
 * @param {false | (import('./schemas/datasource.schema.js').DatasourceSpec & {dir: string})} source
 * @returns {source is import('./schemas/datasource.schema.js').DatasourceSpec & {dir: string}}
 */
const isLoadedSource = (source) => source !== false;

/**
 * @param {import('ora').Ora} [spinner]
 * @returns {Promise<Array<import('./schemas/datasource.schema.js').DatasourceSpec & {dir: string}>>}
 */
export const loadSources = async (spinner) => {
	/** @type {string[]} */
	let sourceDirs = [];
	try {
		sourceDirs = await fs
			.readdir(sourcesDirectory)
			.then((dirs) => dirs.map((dir) => path.join(sourcesDirectory, dir)));
	} catch (e) {
		spinner?.stopAndPersist({
			symbol: '⚠',
			text: chalk.yellow('No sources directory found, no sources to run')
		});
	}

	// Load app-level buildOptions from evidence.config.yaml
	const appLevelBuildOptions = getEvidenceConfig().buildOptions ?? {};

	return /** @type {Array<import('./schemas/datasource.schema.js').DatasourceSpec & {dir: string}>}*/ (
		await Promise.all(
			sourceDirs.map(async (dir) => {
				const sourceConfig = await loadSource(dir);
				if (!sourceConfig) return sourceConfig;

				// Use app-level buildOptions exclusively, ignoring any source-level buildOptions
				return {
					dir,
					...sourceConfig,
					buildOptions: appLevelBuildOptions
				};
			})
		).then((sources) => sources.filter(isLoadedSource))
	);
};
