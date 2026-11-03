/**
 * Static site export (`evidence export`).
 *
 * Produces a self-contained static site that runs without a server:
 *  1. Every table in the project's DuckDB connection is copied to a Parquet
 *     file under `_evidence/data/`, listed in `_evidence/manifest.json`.
 *  2. Every page is rendered through the built SvelteKit app (in-process, like
 *     `evidence validate`) with EVIDENCE_STATIC set, so the page runs its
 *     queries in the browser with DuckDB-WASM (see WasmQueryService) against
 *     those Parquet files. The page's SQL is unchanged: it still reads e.g.
 *     `warehouse.orders`, which the browser recreates as views.
 *  3. The app's client assets and the project's `static/` folder are copied.
 *
 * `--base /prefix` hosts the site under a sub-path (e.g. GitHub Pages project
 * sites): asset URLs in the HTML are made absolute under the prefix, and a small
 * script prefixes root-relative links (`/page`) that pages render at runtime.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Server as ServerType, SSRManifest } from '@sveltejs/kit';
import { loadProjectConfig } from './project-config/load-config.ts';
import { executeQuery, loadConnectionConfig, type ConnectionConfig } from './connection/index.ts';

export interface StaticExportOptions {
	/** Path to the Evidence project root. Defaults to cwd. */
	projectRoot?: string;
	/** Directory to write the site into. Defaults to ./dist. */
	outputDir?: string;
	/** URL prefix the site is hosted under, e.g. `/my-site`. Defaults to the site root. */
	base?: string;
}

/** Kept in sync with the manifest type WasmQueryService reads. */
interface ManifestTable {
	/** Attached database the table lives in; null for the connection's default database. */
	catalog: string | null;
	schema: string;
	name: string;
	/** Path relative to the site root. */
	file: string;
	rowCount: number;
}

function normalizeBase(base: string | undefined): string {
	const trimmed = (base ?? '').trim().replace(/\/+$/, '');
	if (!trimmed) return '';
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// 1. Tables → Parquet
// ---------------------------------------------------------------------------

async function exportTables(
	config: ConnectionConfig,
	outputBase: string
): Promise<ManifestTable[]> {
	// The native `type: duckdb` connector comes from the duckdb-connection branch:
	// exporting copies tables with DuckDB's own COPY into local Parquet files.
	if ((config.type as string) !== 'duckdb') {
		throw new Error(
			`evidence export supports \`type: duckdb\` connections only (this project uses \`${config.type}\`).`
		);
	}

	const [{ db }] = (await executeQuery('SELECT current_database() AS db', config)).rows as {
		db: string;
	}[];
	const { rows } = await executeQuery(
		`SELECT table_catalog, table_schema, table_name
		 FROM information_schema.tables
		 WHERE table_catalog NOT IN ('system', 'temp')
		   AND table_schema NOT IN ('information_schema', 'pg_catalog')
		 ORDER BY 1, 2, 3`,
		config
	);

	const tables: ManifestTable[] = [];
	for (const row of rows as { table_catalog: string; table_schema: string; table_name: string }[]) {
		const catalog = row.table_catalog === db ? null : row.table_catalog;
		const parts = [catalog, row.table_schema, row.table_name].filter((p): p is string => !!p);
		const file = `_evidence/data/${parts.join('/')}.parquet`;
		const target = path.join(outputBase, file);
		const qualified = [row.table_catalog, row.table_schema, row.table_name].map(quoteIdent).join('.');

		process.stdout.write(`  ${pc.dim(parts.join('.'))} ... `);
		await mkdir(path.dirname(target), { recursive: true });
		await executeQuery(
			`COPY (FROM ${qualified}) TO ${sqlString(target)} (FORMAT parquet, COMPRESSION zstd)`,
			config
		);
		const [{ n }] = (await executeQuery(`SELECT count(*)::INTEGER AS n FROM ${qualified}`, config))
			.rows as { n: number }[];
		console.log(pc.green('✓') + pc.dim(` ${n.toLocaleString()} rows`));

		tables.push({ catalog, schema: row.table_schema, name: row.table_name, file, rowCount: n });
	}
	return tables;
}

// ---------------------------------------------------------------------------
// 2. Pages → HTML
// ---------------------------------------------------------------------------

/**
 * URL slugs for every page under pagesDir ('' is the home page), plus the
 * `folder/index` aliases of folder index pages. A folder's index page is
 * rendered once, at `/folder`; its `/folder/index` alias only redirects there.
 */
async function discoverPageSlugs(
	pagesDir: string
): Promise<{ slugs: string[]; indexAliases: string[] }> {
	const slugs = new Set<string>();
	const folderIndexes: string[] = [];
	async function walk(dir: string) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && entry.name !== 'node_modules') await walk(full);
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				// Single-tree projects keep partials next to pages, marked in frontmatter.
				const head = (await readFile(full, 'utf-8')).slice(0, 2000);
				if (/^---[\s\S]*?^type:\s*partial\s*$[\s\S]*?^---/m.test(head)) continue;
				const rel = path.relative(pagesDir, full).split(path.sep).join('/').replace(/\.md$/, '');
				if (rel === 'index') slugs.add('');
				else if (rel.endsWith('/index')) folderIndexes.push(rel);
				else slugs.add(rel);
			}
		}
	}
	await walk(pagesDir);
	const indexAliases: string[] = [];
	for (const rel of folderIndexes) {
		const folder = rel.slice(0, -'/index'.length);
		// `folder.md` next to `folder/index.md` owns `/folder`, leaving the index
		// page reachable only at `/folder/index`: render it there.
		if (slugs.has(folder)) slugs.add(rel);
		else {
			slugs.add(folder);
			indexAliases.push(rel);
		}
	}
	return { slugs: [...slugs].sort(), indexAliases: indexAliases.sort() };
}

/** A static page that sends `/folder/index` on to `/folder`. */
function redirectHtml(target: string): string {
	const url = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	return `<!doctype html><meta charset="utf-8"><title>Redirecting…</title><link rel="canonical" href="${url}"><meta http-equiv="refresh" content="0; url=${url}"><script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script><a href="${url}">${url}</a>\n`;
}

/**
 * Prefixes root-relative links with the site base at runtime: links rendered
 * by components (sidebar, markdown, table link columns) are written as `/page`.
 * Navigation is a full page load (data-sveltekit-reload) — there is no server
 * to answer SvelteKit's client-side data requests.
 */
function baseLinkScript(base: string): string {
	return `<script>(() => {
	const base = ${JSON.stringify(base)};
	const fix = (u) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && u !== base && !u.startsWith(base + '/') ? base + u : u;
	const fixEl = (el) => { const href = el.getAttribute && el.getAttribute('href'); const fixed = fix(href); if (fixed !== href) el.setAttribute('href', fixed); };
	const scan = (node) => { if (node.nodeType !== 1) return; fixEl(node); node.querySelectorAll('[href^="/"]').forEach(fixEl); };
	new MutationObserver((mutations) => { for (const m of mutations) m.type === 'attributes' ? fixEl(m.target) : m.addedNodes.forEach(scan); })
		.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
	// Content links rewrite their own href when clicked (to carry filter params),
	// after the observer ran; re-apply the base once their handlers are done.
	window.addEventListener('click', (e) => { const a = e.target instanceof Element && e.target.closest('a[href]'); if (a) fixEl(a); });
	const open = window.open;
	window.open = function (url, ...rest) { return open.call(this, typeof url === 'string' ? fix(url) : url, ...rest); };
})();</script>`;
}

/** Make a page rendered at `http://localhost/<slug>` work from any URL under `base`. */
export function rewriteHtml(html: string, base: string): string {
	let out = html
		// SvelteKit renders asset URLs relative to the request path (`./_app`, `../../_app`).
		.replace(/(["'(])(?:\.\.?\/)+(_app\/)/g, `$1${base}/$2`)
		// …and computes its base path at runtime from the same relative prefix.
		.replace(
			/new URL\("\.{1,2}(?:\/\.\.)*\/?", location\)\.pathname\.slice\(0, -1\)/g,
			JSON.stringify(base)
		)
		// Full page loads for every link; no hover preloading of server data.
		.replace(/data-sveltekit-preload-data="[^"]*"/, 'data-sveltekit-preload-data="off" data-sveltekit-reload');
	if (base) {
		out = out
			.replace(/\b(href|src)="\/(?!\/)([^"]*)"/g, (match, attr, rest) =>
				`/${rest}`.startsWith(`${base}/`) ? match : `${attr}="${base}/${rest}"`
			)
			.replace('</head>', `${baseLinkScript(base)}</head>`);
	}
	return out;
}

async function loadServer(): Promise<ServerType> {
	if (path.basename(process.execPath).startsWith('bun')) {
		throw new Error(
			'evidence export needs the built app: run it from the compiled `evidence` binary.'
		);
	}
	// @ts-expect-error - generated at build time
	const manifest: SSRManifest = (await import('../manifest.js')).default;
	const { Server } = (await import('../server/index.js')) as {
		Server: new (manifest: SSRManifest) => ServerType;
	};
	const server = new Server(manifest);
	await server.init({ env: Bun.env as Record<string, string> });
	return server;
}

async function render(server: ServerType, pathname: string): Promise<Response> {
	return server.respond(new Request(`http://localhost${pathname}`), {
		getClientAddress: () => '127.0.0.1'
	});
}

// ---------------------------------------------------------------------------
// 3. Client assets
// ---------------------------------------------------------------------------

async function copyClientAssets(outputBase: string): Promise<number> {
	// @ts-expect-error - generated at build time
	const { assetMap } = (await import('./assets.generated.ts')) as {
		assetMap: Map<string, { path: string; gzipped: boolean }>;
	};
	for (const [routePath, asset] of assetMap) {
		let bytes = new Uint8Array(await Bun.file(asset.path).arrayBuffer());
		if (asset.gzipped) bytes = Bun.gunzipSync(bytes);
		const target = path.join(outputBase, routePath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
	return assetMap.size;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function staticExport(options: StaticExportOptions = {}): Promise<void> {
	const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
	const outputBase = path.resolve(options.outputDir ?? path.join(projectRoot, 'dist'));
	const base = normalizeBase(options.base);

	console.log(pc.bold('\nEvidence Static Export'));
	console.log(pc.dim(`  Project: ${projectRoot}`));
	console.log(pc.dim(`  Output:  ${outputBase}`));
	console.log(pc.dim(`  Base:    ${base || '/'}`));
	console.log('');

	const config = await loadProjectConfig(projectRoot);
	const connection = await loadConnectionConfig(projectRoot);
	if (!connection) {
		console.error(pc.red('evidence export needs a connection.yaml in the project root.'));
		process.exit(1);
	}

	// Regenerated output only; anything else in the output dir is left alone.
	await rm(path.join(outputBase, '_app'), { recursive: true, force: true });
	await rm(path.join(outputBase, '_evidence'), { recursive: true, force: true });
	await mkdir(outputBase, { recursive: true });

	console.log('Exporting tables...');
	const tables = await exportTables(connection, outputBase);
	await writeFile(
		path.join(outputBase, '_evidence', 'manifest.json'),
		JSON.stringify({ generatedAt: new Date().toISOString(), tables }, null, 2)
	);

	console.log('\nRendering pages...');
	// Read by the app's routes (lib/server/serve-mode.ts) when rendering below.
	// Set after exporting tables: serve mode locks the DuckDB connection.
	process.env.EVIDENCE_PROJECT_CWD = projectRoot;
	process.env.EVIDENCE_SERVE = '1';
	process.env.EVIDENCE_STATIC = '1';
	process.env.EVIDENCE_STATIC_BASE = base;
	const server = await loadServer();

	const { slugs, indexAliases } = await discoverPageSlugs(config.pagesDir);
	let failures = 0;
	for (const slug of slugs) {
		process.stdout.write(`  ${pc.dim('/' + slug)} ... `);
		const response = await render(server, `/${slug}`);
		if (!response.ok) {
			failures++;
			console.log(pc.red(`✗ ${response.status}`));
			continue;
		}
		const target = path.join(outputBase, slug, 'index.html');
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, rewriteHtml(await response.text(), base));
		console.log(pc.green('✓'));
	}
	for (const alias of indexAliases) {
		const target = path.join(outputBase, alias, 'index.html');
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, redirectHtml(`${base}/${alias.slice(0, -'/index'.length)}`));
	}

	// Not-found page (GitHub Pages and most static hosts serve /404.html).
	const notFound = await render(server, '/__evidence_not_found__');
	await writeFile(path.join(outputBase, '404.html'), rewriteHtml(await notFound.text(), base));

	// Project favicon (`favicon:` in evidence.config.yaml) is served by a route.
	const favicon = await render(server, '/__evidence/favicon');
	if (favicon.ok) {
		await mkdir(path.join(outputBase, '__evidence'), { recursive: true });
		await writeFile(
			path.join(outputBase, '__evidence', 'favicon'),
			new Uint8Array(await favicon.arrayBuffer())
		);
	}

	console.log('\nCopying assets...');
	const assetCount = await copyClientAssets(outputBase);
	const staticDir = path.join(projectRoot, 'static');
	if (existsSync(staticDir)) await cp(staticDir, outputBase, { recursive: true });
	// Keep GitHub Pages' Jekyll from dropping `_app/` and `_evidence/`.
	await writeFile(path.join(outputBase, '.nojekyll'), '');

	console.log('');
	console.log(pc.bold('Done.'));
	console.log(`  ${tables.length} tables, ${slugs.length - failures} pages, ${assetCount} app assets`);
	if (failures > 0) {
		console.log(pc.red(`  ${failures} pages failed to render`));
		process.exit(1);
	}
}
