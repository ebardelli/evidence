/**
 * Custom SvelteKit adapter for building a single executable CLI
 * Based on jesterkit/exe-sveltekit, simplified for our needs
 */

import { join, dirname, extname } from 'path';
import { writeFile, readdir, stat, readFile, mkdir, cp } from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { parse, relative, normalize } from 'path';

// ============================================================================
// Constants
// ============================================================================

const ADAPTER_NAME = 'evd-adapter';
const BUILD_DIR = `.svelte-kit/${ADAPTER_NAME}`;
const TARGETS_MAP = {
	'linux-x64': 'bun-linux-x64',
	'linux-arm64': 'bun-linux-arm64',
	'macos-arm64': 'bun-darwin-arm64',
	'darwin-arm64': 'bun-darwin-arm64',
	'darwin-x64': 'bun-darwin-x64',
	'windows-x64': 'bun-windows-x64'
};

// `@duckdb/node-bindings` picks its native addon via a `process.platform`/`arch`
// switch at require-time, so bun's bundler can't statically embed it — it's
// marked `--external` below (see the bun build step) and copied next to the
// compiled binary instead, keyed by the same target strings as TARGETS_MAP.
const DUCKDB_BINDINGS_PLATFORM = {
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
	'macos-arm64': 'darwin-arm64',
	'darwin-arm64': 'darwin-arm64',
	'darwin-x64': 'darwin-x64',
	'windows-x64': 'win32-x64'
};

// ============================================================================
// Asset Embedding
// ============================================================================

// Compressible-by-extension; images/fonts are already compressed formats.
const GZIP_EXTENSIONS = new Set([
	'.js',
	'.mjs',
	'.css',
	'.html',
	'.json',
	'.svg',
	'.txt',
	'.xml',
	'.map',
	'.wasm',
	'.webmanifest'
]);
// Below this, gzip framing overhead eats the gain.
const GZIP_MIN_BYTES = 1024;

const MIME_BY_EXT = {
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.html': 'text/html',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.txt': 'text/plain',
	'.xml': 'application/xml',
	'.map': 'application/json',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.pdf': 'application/pdf'
};

function mimeFor(routePath) {
	return MIME_BY_EXT[extname(routePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * @param {Array<{filePath: string, routePath: string, varName: string, isPrerendered: boolean, gzipped?: boolean}>} assets
 * @param {string} buildDir
 */
async function compressAssets(assets, buildDir) {
	let saved = 0;
	for (const asset of assets) {
		if (!GZIP_EXTENSIONS.has(extname(asset.routePath).toLowerCase())) continue;
		const content = await readFile(asset.filePath);
		if (content.length < GZIP_MIN_BYTES) continue;
		const compressed = gzipSync(content, { level: 9 });
		if (compressed.length >= content.length) continue;
		const gzPath = join(
			buildDir,
			'gz',
			asset.isPrerendered ? 'prerendered' : 'client',
			asset.routePath
		);
		await mkdir(dirname(gzPath), { recursive: true });
		await writeFile(gzPath, compressed);
		saved += content.length - compressed.length;
		asset.filePath = gzPath;
		asset.gzipped = true;
	}
	return saved;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function generateVarName(filePath) {
	const { name, ext } = parse(filePath);
	let cleanName = name
		.replace(/[^a-zA-Z0-9]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');

	if (/^[0-9]/.test(cleanName)) cleanName = `asset_${cleanName}`;
	if (!cleanName) cleanName = 'asset';

	const normalizedPath = normalize(filePath).replace(/\\/g, '/');
	const pathHash = createHash('md5').update(normalizedPath).digest('hex').slice(0, 4);
	const extSuffix = ext.replace('.', '').toUpperCase();

	return `${cleanName}_${extSuffix}_${pathHash}`;
}

/**
 * @param {string} clientDir
 * @param {string} prerenderedDir
 * @returns {Promise<Array<{filePath: string, routePath: string, varName: string, isPrerendered: boolean}>>}
 */
async function discoverAssets(clientDir, prerenderedDir) {
	/** @type {Array<{filePath: string, routePath: string, varName: string, isPrerendered: boolean}>} */
	const assets = [];

	/**
	 * @param {string} dir
	 * @param {boolean} isPrerendered
	 */
	async function walk(dir, isPrerendered) {
		const exists = await stat(dir).catch(() => false);
		if (!exists) return;

		const entries = await readdir(dir);
		for (const entry of entries) {
			const fullPath = join(dir, entry);
			const stats = await stat(fullPath);

			if (stats.isDirectory()) {
				await walk(fullPath, isPrerendered);
			} else {
				const baseDir = isPrerendered ? prerenderedDir : clientDir;
				const routePath = '/' + relative(baseDir, fullPath).replace(/\\/g, '/');
				assets.push({
					filePath: fullPath,
					routePath,
					varName: generateVarName(routePath),
					isPrerendered
				});
			}
		}
	}

	await Promise.all([walk(clientDir, false), walk(prerenderedDir, true)]);
	return assets;
}

/**
 * @param {Array<{filePath: string, routePath: string, varName: string, isPrerendered: boolean}>} assets
 * @returns {string}
 */
function generateAssetImports(assets) {
	const imports = assets
		.map((asset) => {
			const treeDir = asset.isPrerendered ? 'prerendered' : 'client';
			const relativePath = asset.gzipped
				? `../gz/${treeDir}${asset.routePath}`
				: `../${treeDir}${asset.routePath}`;
			return `import ${asset.varName} from "${relativePath}" with { type: "file" };`;
		})
		.join('\n');

	const mapEntries = assets
		.map(
			(asset) =>
				`  ["${asset.routePath}", { path: ${asset.varName}, type: "${mimeFor(asset.routePath)}", gzipped: ${asset.gzipped ? 'true' : 'false'} }]`
		)
		.join(',\n');

	return `// Auto-generated asset imports - DO NOT EDIT
// @ts-nocheck
export interface EmbeddedAsset {
	path: string;
	type: string;
	gzipped: boolean;
}

${imports}

export const assetMap: Map<string, EmbeddedAsset> = new Map([
${mapEntries}
]);
`;
}

// ============================================================================
// Native addons
// ============================================================================

/**
 * `@duckdb/node-bindings` resolves its native addon via a `require()` chosen by
 * `process.platform`/`arch` at runtime, so it's excluded from the bun bundle
 * (`--external` above) rather than statically bundled. A compiled bun
 * executable is meant to be copied anywhere as a single portable file, so
 * nothing can be shipped *alongside* it on disk — the addon's bytes have to
 * live *inside* the binary. Stage the one platform package the binary
 * actually needs and generate a module that imports each of its files with
 * `{ type: "file" }`, which bun embeds directly into the compiled binary.
 * `duckdb.ts`'s ensureDuckdbNativeAddonAvailable() extracts those bytes to a
 * stable on-disk cache the first time a duckdb query actually runs.
 *
 * `duckdb.ts` is bundled into the final binary twice — once directly by bun
 * (following the CLI entrypoint under temp-cli/) and once by Rollup as part
 * of the SvelteKit server build (buildDir/server/...), since the web app
 * itself runs real queries against connection.yaml. Rollup relocates
 * externalized modules into chunks at a depth we don't control, so a
 * relative output path would only ever match one of the two copies. Instead
 * this writes a real node_modules-shaped package directly under `buildDir` —
 * a shared ancestor of both `temp-cli/connection/duckdb.ts` and
 * `server/chunks/*.js` — so ordinary bare-specifier node_modules resolution
 * (which both bun and Rollup's external passthrough rely on, per
 * duckdb.ts's `import('duckdb-native-assets-generated')` and vite.config.ts's
 * matching `external` matcher) finds the same package from either location.
 */
async function generateDuckDBNativeAssetsModule(target, buildDir, log) {
	const platform = target ? DUCKDB_BINDINGS_PLATFORM[target] : `${process.platform}-${process.arch}`;
	const pkgDirName = `node-bindings-${platform}`;
	const pkgDir = join(buildDir, 'node_modules', 'duckdb-native-assets-generated');
	await mkdir(pkgDir, { recursive: true });
	await writeFile(
		join(pkgDir, 'package.json'),
		JSON.stringify({ name: 'duckdb-native-assets-generated', main: './index.ts' }, null, 2),
		'utf-8'
	);
	const outFile = join(pkgDir, 'index.ts');

	// Resolve via Node's own algorithm (not a hardcoded path) so this finds the
	// package wherever pnpm actually placed it — hoisted to the workspace root
	// (shamefully-hoist) or nested under this package, monorepo layout aside.
	let srcDir;
	try {
		srcDir = dirname(fileURLToPath(import.meta.resolve(`@duckdb/${pkgDirName}/package.json`)));
	} catch {
		log.warn(
			`[duckdb] "@duckdb/${pkgDirName}" isn't installed — the compiled binary won't have a working DuckDB connector for ${platform}. Install it for this platform before building, or build on/for a matching host.`
		);
		await writeFile(outFile, 'export const duckdbNativeAssets = null;\n', 'utf-8');
		return;
	}

	const stagingDir = join(pkgDir, '__duckdb_native__');
	await mkdir(stagingDir, { recursive: true });

	const entries = await readdir(srcDir);
	const imports = [];
	const mapEntries = [];
	await Promise.all(
		entries.map((name, i) => {
			// bun's bundler special-cases the `.node` extension even under
			// `type: "file"` (it tries to treat it as a Node-API module to
			// require, not a raw asset) — stage it under a different extension
			// for the import; the real name is preserved in the file map below
			// and used to name the extracted file on disk at runtime.
			const stagedName = extname(name) === '.node' ? `${name}.bin` : name;
			imports.push(
				`import duckdbAsset${i} from "./__duckdb_native__/${stagedName}" with { type: "file" };`
			);
			mapEntries.push(`\t${JSON.stringify(name)}: duckdbAsset${i}`);
			return cp(join(srcDir, name), join(stagingDir, stagedName));
		})
	);

	const moduleSource = `// Auto-generated by cli/adapter/index.js — DO NOT EDIT
${imports.join('\n')}

export const duckdbNativeAssets = {
	pkgDirName: ${JSON.stringify(pkgDirName)},
	files: {
${mapEntries.join(',\n')}
	}
};
`;
	await writeFile(outFile, moduleSource, 'utf-8');
	log.success(`DuckDB native addon embedded (${platform})`);
}

// ============================================================================
// Adapter
// ============================================================================

/**
 * @param {{ out?: string, binaryName?: string, target?: string }} [options]
 * @returns {import('@sveltejs/kit').Adapter}
 */
export default function adapter(options = {}) {
	return {
		name: ADAPTER_NAME,

		/**
		 * @param {import('@sveltejs/kit').Builder} builder
		 */
		async adapt(builder) {
			// Allow target override from environment (for CI cross-compilation)
			const targetFromEnv = process.env.CLI_BUILD_TARGET;

			const opts = {
				out: 'dist',
				binaryName: 'evidence',
				...options,
				target: options.target || targetFromEnv
			};

			// Clean and create directories
			builder.rimraf(BUILD_DIR);
			builder.mkdirp(BUILD_DIR);
			builder.rimraf(opts.out);
			builder.mkdirp(opts.out);

			// Write SvelteKit output
			builder.writeClient(join(BUILD_DIR, 'client'));
			builder.writePrerendered(join(BUILD_DIR, 'prerendered'));
			builder.writeServer(join(BUILD_DIR, 'server'));
			builder.rimraf(join(BUILD_DIR, 'server', '_app'));
			builder.log.success('SvelteKit build complete');

			// Copy our CLI template
			const cliTemplatePath = join(process.cwd(), 'cli');
			builder.copy(cliTemplatePath, join(BUILD_DIR, 'temp-cli'));
			builder.log.success('CLI template copied');

			// Generate manifest
			const manifest = builder.generateManifest({ relativePath: './server' });
			const manifestModule = `const manifest = ${manifest};\nexport default manifest;`;
			await writeFile(join(BUILD_DIR, 'manifest.js'), manifestModule, 'utf-8');
			builder.log.success('Manifest generated');

			// Generate asset imports (the embedding magic)
			const assets = await discoverAssets(
				join(BUILD_DIR, 'client'),
				join(BUILD_DIR, 'prerendered')
			);
			const savedBytes = await compressAssets(assets, BUILD_DIR);
			builder.log.success(
				`Assets gzipped (${(savedBytes / (1024 * 1024)).toFixed(1)} MB saved)`
			);
			const assetImports = generateAssetImports(assets);
			await writeFile(join(BUILD_DIR, 'temp-cli', 'assets.generated.ts'), assetImports, 'utf-8');
			builder.log.success(`Asset imports generated (${assets.length} files)`);

			// Embed the DuckDB native addon (see generateDuckDBNativeAssetsModule)
			await generateDuckDBNativeAssetsModule(opts.target, BUILD_DIR, builder.log);

			// Compile
			const entryPoint = join(BUILD_DIR, 'temp-cli/index.ts');
			const isWindows = opts.target
				? opts.target.startsWith('windows-')
				: process.platform === 'win32';
			const outFile = join(opts.out, opts.binaryName + (isWindows ? '.exe' : ''));

			// Databricks kernel (CLI is Thrift-only) and vite (source-mode only) never load from the binary.
			// @duckdb/node-bindings-* (see DUCKDB_BINDINGS_PLATFORM above) is excluded from static
			// bundling too — its native addon is embedded instead (generateDuckDBNativeAssetsModule).
			const bunArgs = [
				'build',
				'--compile',
				'--minify',
				'--external',
				'@databricks/databricks-sql-kernel-*',
				'--external',
				'@duckdb/node-bindings-*',
				'--external',
				'vite'
			];
			if (opts.target) bunArgs.push(`--target=${TARGETS_MAP[opts.target]}`);
			bunArgs.push(entryPoint, '--outfile', outFile);
			const result = spawnSync('bun', bunArgs, { stdio: 'inherit' });
			if (result.status !== 0) throw new Error(`bun build exited with code ${result.status}`);

			const stats = await stat(outFile);
			const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
			builder.log.success(`Binary compiled: ${outFile} (${sizeMb} MB)`);
		},

		supports: {
			read: () => true
		}
	};
}
