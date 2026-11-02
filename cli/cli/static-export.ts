/**
 * Static site export for Evidence CLI.
 *
 * Discovers all markdown pages, extracts named SQL queries (with filter
 * placeholders stripped), runs them against the warehouse, saves results as
 * Parquet files, and writes a manifest.json catalog. The output is consumed
 * by WasmQueryService in the browser — no server required.
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { loadProjectConfig } from './project-config/load-config.ts';
import { executeQuery, type QueryResultData } from './query.ts';
import pc from 'picocolors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StaticExportOptions {
	/** Path to the Evidence project root. Defaults to cwd. */
	projectRoot?: string;
	/** Directory to write Parquet files and manifest.json into. Defaults to ./dist. */
	outputDir?: string;
	/** Maximum number of queries to execute concurrently. */
	concurrency?: number;
}

interface QueryManifestEntry {
	file: string;
	columns: Array<{ name: string; type: string }>;
	rowCount: number;
}

export interface StaticManifest {
	generatedAt: string;
	queries: Record<string, QueryManifestEntry>;
}

interface ExtractedQuery {
	name: string;
	sql: string;
	sourcePage: string;
}

// ---------------------------------------------------------------------------
// SQL extraction from markdown
// ---------------------------------------------------------------------------

/**
 * Extract named ```sql fences from a markdown file.
 * Markdoc syntax: ```sql {name}\n{sql}\n```
 * Only fences with a name (the meta field after "sql ") are included —
 * anonymous sql blocks can't be mapped to a stable Parquet file name.
 */
function extractSqlFences(markdown: string, slug: string): ExtractedQuery[] {
	const queries: ExtractedQuery[] = [];
	// Match ```sql name\n...content...\n``` (backtick fence, greedy content)
	const FENCE_RE = /^```sql\s+(\S+)\s*\n([\s\S]*?)\n```/gm;
	let match;
	while ((match = FENCE_RE.exec(markdown)) !== null) {
		const [, name, sql] = match;
		if (name && sql.trim()) {
			queries.push({ name, sql: sql.trim(), sourcePage: slug });
		}
	}
	return queries;
}

/**
 * Strip filter conditions from SQL so the full unfiltered dataset is fetched.
 *
 * Evidence uses two filter syntaxes:
 *  - [[optional WHERE clause]]  →  removed entirely (the block is conditional)
 *  - {{filter_id}} or {{filter_id.value}}  →  replaced with NULL (bare refs)
 *
 * After removal we clean up orphaned SQL keywords that were connecting the
 * filter block to the rest of the query (e.g. `WHERE AND`, `AND AND`).
 *
 * The resulting SQL runs against the warehouse and its output is stored as
 * a Parquet file. At runtime, DuckDB-WASM re-runs the original SQL (with
 * live filter values) against the Parquet data.
 */
function stripFilterConditions(sql: string): string {
	// Remove [[...]] conditional blocks (may span multiple lines, lazy match)
	let stripped = sql.replace(/\[\[[\s\S]*?\]\]/g, ' ');
	// Replace remaining {{...}} placeholders with NULL
	stripped = stripped.replace(/\{\{[^}]+\}\}/g, 'NULL');
	// Collapse whitespace so keyword patterns below are reliable
	stripped = stripped.replace(/\s+/g, ' ').trim();

	// Clean up dangling SQL keywords left by block removal.
	// Run repeatedly until stable (one pass may expose a new pattern).
	let prev = '';
	while (prev !== stripped) {
		prev = stripped;
		// WHERE followed immediately by AND/OR → WHERE (the block was the only condition)
		stripped = stripped.replace(/\bWHERE\s+(AND|OR)\b/gi, 'WHERE');
		// AND/OR followed by another AND/OR → keep the latter
		stripped = stripped.replace(/\b(AND|OR)\s+(AND|OR)\b/gi, '$2');
		// Trailing AND/OR before end of string or before a clause keyword
		stripped = stripped.replace(/\b(AND|OR)\s*$/i, '');
		stripped = stripped.replace(/\b(AND|OR)\s+(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING)\b/gi, '$2');
		// Trailing WHERE with nothing after (end of clause)
		stripped = stripped.replace(/\bWHERE\s*$/i, '');
		// WHERE followed by GROUP BY / ORDER BY / LIMIT / HAVING (block was the only predicate)
		stripped = stripped.replace(/\bWHERE\s+(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING)\b/gi, '$1');
	}

	return stripped.trim();
}

// ---------------------------------------------------------------------------
// Page discovery (no SvelteKit / Vite deps)
// ---------------------------------------------------------------------------

async function discoverPages(
	pagesDir: string
): Promise<Array<{ slug: string; content: string }>> {
	const pages: Array<{ slug: string; content: string }> = [];

	async function walk(dir: string) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
					await walk(full);
				}
			} else if (entry.isFile() && entry.name.endsWith('.md')) {
				const content = await readFile(full, 'utf-8');
				// slug is the path relative to pagesDir, without extension
				const rel = full.slice(pagesDir.length + 1).replace(/\\/g, '/');
				const slug = rel.replace(/\.md$/, '');
				pages.push({ slug, content });
			}
		}
	}

	await walk(pagesDir);
	return pages;
}

// ---------------------------------------------------------------------------
// Parquet writing via DuckDB node API
// ---------------------------------------------------------------------------

/**
 * Write query result rows to a Parquet file using DuckDB.
 * Strategy: serialize rows as NDJSON to a temp file, then use DuckDB's
 * read_json_auto() to load and COPY TO parquet. This avoids manually
 * constructing a DuckDB schema from JS types.
 */
async function writeParquet(
	instance: import('@duckdb/node-api').DuckDBInstance,
	rows: Record<string, unknown>[],
	outputPath: string
): Promise<void> {
	if (rows.length === 0) {
		// Can't infer a schema from zero rows — write an empty marker file.
		// DuckDB-WASM will see zero rows when it queries this dataset.
		await writeFile(outputPath.replace(/\.parquet$/, '.empty'), '');
		return;
	}

	const tmp = join(
		tmpdir(),
		`evd-static-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`
	);
	await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');

	const conn = await instance.connect();
	try {
		// DuckDB SQL needs forward-slash paths even on Windows
		const src = tmp.replace(/\\/g, '/');
		const dst = outputPath.replace(/\\/g, '/');
		await conn.run(
			`COPY (SELECT * FROM read_json_auto('${src}')) TO '${dst}' (FORMAT PARQUET, COMPRESSION ZSTD)`
		);
	} finally {
		conn.disconnectSync();
		await unlink(tmp).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

async function runWithLimit<T>(
	tasks: Array<() => Promise<T>>,
	limit: number
): Promise<Array<T | Error>> {
	const results: Array<T | Error> = new Array(tasks.length);
	let next = 0;

	async function worker() {
		while (next < tasks.length) {
			const i = next++;
			try {
				results[i] = await tasks[i]();
			} catch (err) {
				results[i] = err instanceof Error ? err : new Error(String(err));
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function staticExport(options: StaticExportOptions = {}): Promise<void> {
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const outputBase = resolve(options.outputDir ?? join(projectRoot, 'dist'));
	const dataDir = join(outputBase, '_evidence', 'data');
	const manifestPath = join(outputBase, '_evidence', 'manifest.json');
	const concurrency = options.concurrency ?? 5;

	console.log(pc.bold('\nEvidence Static Export'));
	console.log(pc.dim(`  Project: ${projectRoot}`));
	console.log(pc.dim(`  Output:  ${outputBase}`));
	console.log('');

	// 1. Load project config (pagesDir, etc.)
	const config = await loadProjectConfig(projectRoot);

	// 2. Discover all pages
	const pages = await discoverPages(config.pagesDir);
	if (pages.length === 0) {
		console.log(pc.yellow('No markdown pages found in project.'));
		return;
	}
	console.log(`  ${pc.dim('pages:')} ${pages.length}`);

	// 3. Extract SQL queries from all pages (deduplicated by name)
	const queryMap = new Map<string, ExtractedQuery>();
	for (const page of pages) {
		for (const q of extractSqlFences(page.content, page.slug)) {
			if (!queryMap.has(q.name)) {
				queryMap.set(q.name, q);
			} else {
				const existing = queryMap.get(q.name)!;
				if (existing.sourcePage !== page.slug) {
					console.warn(
						pc.yellow(
							`  ⚠ Query "${q.name}" in ${page.slug} shadows definition from ${existing.sourcePage}`
						)
					);
				}
			}
		}
	}

	if (queryMap.size === 0) {
		console.log(pc.yellow('No named SQL queries found in pages (```sql name blocks).'));
		return;
	}
	console.log(`  ${pc.dim('queries:')} ${queryMap.size}`);
	console.log('');

	// 4. Execute queries in parallel against warehouse
	console.log('Executing queries...');
	const queries = [...queryMap.values()];
	const queryResults = new Map<string, QueryResultData>();

	const executionTasks = queries.map((q) => async () => {
		const stripped = stripFilterConditions(q.sql);
		process.stdout.write(`  ${pc.dim(q.name)} ... `);
		const result = await executeQuery(stripped);
		queryResults.set(q.name, result);
		console.log(pc.green(`✓`) + pc.dim(` ${result.rows.length} rows`));
		return result;
	});

	const execResults = await runWithLimit(executionTasks, concurrency);

	const failedQueries = queries.filter((_, i) => execResults[i] instanceof Error);
	if (failedQueries.length > 0) {
		console.log('');
		for (const [i, q] of queries.entries()) {
			const r = execResults[i];
			if (r instanceof Error) {
				console.log(`  ${pc.red('✗')} ${q.name}: ${r.message}`);
			}
		}
	}

	if (queryResults.size === 0) {
		console.log(pc.red('\nAll queries failed. No files written.'));
		process.exit(1);
	}

	// 5. Write Parquet files using DuckDB
	console.log('\nWriting Parquet files...');
	await mkdir(dataDir, { recursive: true });

	let duckdb: typeof import('@duckdb/node-api');
	try {
		duckdb = await import('@duckdb/node-api');
	} catch {
		console.error(
			pc.red('\nError: @duckdb/node-api is required for Parquet export.') +
				'\nInstall it with: pnpm add @duckdb/node-api'
		);
		process.exit(1);
	}

	const dbInstance = await duckdb.DuckDBInstance.create(':memory:');
	const manifest: StaticManifest = {
		generatedAt: new Date().toISOString(),
		queries: {}
	};

	try {
		for (const [name, result] of queryResults) {
			const dataPath = `_evidence/data/${name}.parquet`;
			const outputPath = join(outputBase, dataPath);
			process.stdout.write(`  ${pc.dim(name)} ... `);
			try {
				await writeParquet(dbInstance, result.rows, outputPath);
				manifest.queries[name] = {
					file: dataPath,
					columns: result.columns.map((c) => ({
						name: c.name,
						type: (c as { type?: string }).type ?? 'unknown'
					})),
					rowCount: result.rows.length
				};
				console.log(pc.green('✓'));
			} catch (err) {
				console.log(pc.red(`✗ ${err instanceof Error ? err.message : err}`));
			}
		}
	} finally {
		dbInstance.closeSync();
	}

	// 6. Write manifest
	await mkdir(join(outputBase, '_evidence'), { recursive: true });
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

	// 7. Summary
	const successCount = Object.keys(manifest.queries).length;
	const failCount = queryMap.size - successCount;
	console.log('');
	console.log(pc.bold('Done.'));
	console.log(`  ${pc.green(`${successCount} quer${successCount === 1 ? 'y' : 'ies'} exported`)}`);
	if (failCount > 0) {
		console.log(`  ${pc.red(`${failCount} failed`)}`);
	}
	console.log(`  ${pc.dim('manifest:')} ${manifestPath}`);
}
