/**
 * Native (in-process, embedded) DuckDB direct connector.
 *
 * Unlike every other connector here, the driver (`@duckdb/node-api`) links a
 * platform-specific native addon (`@duckdb/node-bindings-<platform>`,
 * `require()`d by bare specifier — see that package's duckdb.js). That's fine
 * from source (a normal node_modules optionalDependency), but the compiled
 * CLI binary (cli/adapter/index.js) is a single portable file with nothing
 * shippable alongside it, so the addon's bytes are embedded in the binary
 * instead and have to be extracted to a real on-disk `node_modules` layout
 * before anything imports `@duckdb/node-api` — see
 * ensureDuckdbNativeAddonAvailableForServer's doc comment below for why that
 * means a re-exec, not just an env var mutation.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
// Type-only — erased at compile time, so merely loading this file (e.g. via
// ensureDuckdbNativeAddonIfConfigured's `await import('./connection/duckdb.ts')`,
// or connection/index.ts's static `import ... from './duckdb'`, pulled in by
// every CLI subcommand regardless of connection type) never triggers the real
// `@duckdb/node-api` → `@duckdb/node-bindings` require chain. That chain must
// only run *after* ensureDuckdbNativeAddonAvailable(ForServer) has had a
// chance to extract the addon and put it on NODE_PATH — see loadDuckDBApi.
import type {
	DuckDBInstance as DuckDBInstanceType,
	DuckDBConnection as DuckDBNativeConnection
} from '@duckdb/node-api';
import { normalizeDateRows } from '@evidence/core/connectors/postgres/normalize-date-rows';
import { normalizeNumericRows } from '@evidence/core/connectors/postgres/normalize-numeric-rows';
import { normalizeSparklineRows } from '@evidence/core/connectors/normalize-sparkline-rows';
import { getDuckDBToJsType } from '@evidence/core/connectors/duckdb/type-mapping';
import type { DuckDBCredentials } from '@evidence/core/connectors/duckdb/credentials';
import type { Column } from '@evidence/core/user-components/interfaces/query-service';
import type { QueryResult } from './types';
import { spawnForegroundChild } from '../server.shared.ts';

// ============================================================================
// Native addon availability
// ============================================================================

// See duckdb-native-assets-generated.d.ts for why this only exists inside the
// compiled CLI binary, and why the ambient declaration lives in its own .d.ts.
type DuckdbNativeAssets = { pkgDirName: string; files: Record<string, string> } | null;

const NATIVE_CACHE_ROOT = path.join(os.tmpdir(), 'evidence-cli-duckdb-native');
// Guards against a) redoing the (cheap, but non-zero) extraction work on
// every single query in a process, and b) an infinite re-exec loop — once
// re-exec'd, the child inherits this env var and short-circuits immediately.
const NATIVE_READY_ENV_VAR = 'EVIDENCE_DUCKDB_NATIVE_READY';

let cachedNodePathEntry: string | null | undefined; // undefined = not yet checked

/**
 * Extracts the embedded native addon (if any — null in dev/source mode) to a
 * stable on-disk `node_modules/@duckdb/<pkgDirName>` layout, so
 * `@duckdb/node-bindings`'s own `require('@duckdb/node-bindings-<platform>/duckdb.node')`
 * resolves it normally once `NODE_PATH` includes the returned directory.
 * Re-extracted every time this process needs it (not cached-and-skipped
 * across process runs) — cheap, and avoids ever serving a stale addon from a
 * previous run of a since-rebuilt binary.
 */
async function extractDuckdbNativeAddon(): Promise<string | null> {
	if (cachedNodePathEntry !== undefined) return cachedNodePathEntry;

	let assets: DuckdbNativeAssets;
	try {
		// Routed through a non-literal `string` binding so TypeScript treats the
		// import as `any` instead of trying to statically resolve the module —
		// it only exists inside the compiled binary (see this function's doc
		// comment), never at type-check time.
		const generatedModuleSpecifier: string = 'duckdb-native-assets-generated';
		const mod = (await import(generatedModuleSpecifier)) as { duckdbNativeAssets: DuckdbNativeAssets };
		assets = mod.duckdbNativeAssets;
	} catch {
		assets = null;
	}

	if (!assets) {
		cachedNodePathEntry = null;
		return null;
	}

	const pkgDir = path.join(NATIVE_CACHE_ROOT, 'node_modules', '@duckdb', assets.pkgDirName);
	await mkdir(pkgDir, { recursive: true });
	// `fs.cp`/`cpSync` stat the source first (symlink detection) — bun's
	// virtual `$bunfs` embedded-asset paths don't support that, only a plain
	// read. Read + write the bytes directly instead.
	await Promise.all(
		Object.entries(assets.files).map(async ([name, assetPath]) => {
			const bytes = await readFile(assetPath);
			await writeFile(path.join(pkgDir, name), bytes);
		})
	);

	cachedNodePathEntry = path.join(NATIVE_CACHE_ROOT, 'node_modules');
	return cachedNodePathEntry;
}

function withNativeNodePath(nodePathEntry: string): NodeJS.ProcessEnv {
	const existing = process.env.NODE_PATH;
	return {
		...process.env,
		NODE_PATH: existing ? `${nodePathEntry}${path.delimiter}${existing}` : nodePathEntry,
		[NATIVE_READY_ENV_VAR]: '1'
	};
}

/**
 * Ensures the native addon is resolvable *for this process*, blocking until
 * it is. `NODE_PATH` is only consulted by Node's module resolution once, at
 * process start (`Module._initPaths`) — mutating `process.env.NODE_PATH`
 * after that point has no effect on what's already running. So when
 * extraction is actually needed (compiled binary, first call in this process
 * tree), this re-execs itself with `NODE_PATH` set correctly from the start
 * and exits with the child's status; it never returns in that case.
 *
 * Suitable for a short-lived, one-shot invocation (a CLI subcommand) where
 * blocking on the child and exiting with its status is exactly the desired
 * behavior. A long-running server should use
 * ensureDuckdbNativeAddonAvailableForServer instead, so it can keep forwarding
 * signals to the child instead of blocking on it synchronously.
 */
export async function ensureDuckdbNativeAddonAvailable(): Promise<void> {
	if (process.env[NATIVE_READY_ENV_VAR] === '1') return;

	const nodePathEntry = await extractDuckdbNativeAddon();
	if (!nodePathEntry) return; // dev/source mode — nothing to do

	const result = spawnSync(process.execPath, process.argv.slice(2), {
		stdio: 'inherit',
		env: withNativeNodePath(nodePathEntry)
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

/**
 * Server variant of ensureDuckdbNativeAddonAvailable: re-execs via a
 * non-blocking `spawn` (spawnForegroundChild) instead of `spawnSync`, so this
 * outer process keeps its own signal handling — forwarding SIGINT/SIGTERM to
 * the re-exec'd child — rather than being replaced by (or blocking
 * synchronously on) it. Call this once, before binding a port, never lazily
 * per-request.
 */
export async function ensureDuckdbNativeAddonAvailableForServer(): Promise<void> {
	if (process.env[NATIVE_READY_ENV_VAR] === '1') return;

	const nodePathEntry = await extractDuckdbNativeAddon();
	if (!nodePathEntry) return; // dev/source mode — nothing to do

	const code = await spawnForegroundChild(process.execPath, process.argv.slice(2), {
		env: withNativeNodePath(nodePathEntry)
	});
	process.exit(code);
}

/** Light, synchronous pre-check — used before deciding whether the (async) native-addon dance is worth doing at all. */
export function isDuckdbConnectionYaml(cwd: string): boolean {
	const configPath = path.join(cwd, 'connection.yaml');
	if (!existsSync(configPath)) return false;
	try {
		const parsed = yaml.load(readFileSync(configPath, 'utf-8'));
		return !!parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'duckdb';
	} catch {
		return false;
	}
}

// ============================================================================
// Query execution
// ============================================================================

// The only place `@duckdb/node-api` is actually required — always after
// ensureDuckdbNativeAddonAvailable() has run (see executeDuckDBQuery), so
// NODE_PATH is already correct by the time this first executes. Cached so
// the dynamic import (and its module-init cost) happens once per process.
let duckdbApiModule: Promise<typeof import('@duckdb/node-api')> | null = null;
function loadDuckDBApi(): Promise<typeof import('@duckdb/node-api')> {
	return (duckdbApiModule ??= import('@duckdb/node-api'));
}

/**
 * One cached in-process DuckDB instance per unique (path, setupSql) — reused
 * across queries in this process so `:memory:` state (and anything setupSql
 * ATTACHed) survives between queries, same rationale as motherduck.ts's
 * cached pool. Each query opens (and closes) its own connection from it.
 */
let cachedInstance: { key: string; instance: Promise<DuckDBInstanceType> } | null = null;
let shutdownHandlerRegistered = false;

function configKey(c: DuckDBCredentials): string {
	return JSON.stringify([c.path, c.setupSql]);
}

function closeCachedInstance(entry: { instance: Promise<DuckDBInstanceType> } | null): void {
	entry?.instance.then((instance) => instance.closeSync()).catch(() => {});
}

// Unlike a pg.Pool's sockets, the native addon's open database handle holds a
// background worker-thread pool that a plain `process.exit()` doesn't
// necessarily reap — left open, it can outlive the process's own shutdown
// path and block whatever spawned it (see spawnForegroundChild) from ever
// observing this process exit. Mirrors every other connector's teardown of
// its cached resource, just triggered by a signal instead of a config change.
function registerShutdownHandler(): void {
	if (shutdownHandlerRegistered) return;
	shutdownHandlerRegistered = true;
	const closeOnShutdown = () => closeCachedInstance(cachedInstance);
	process.once('SIGINT', closeOnShutdown);
	process.once('SIGTERM', closeOnShutdown);
}

async function getInstance(config: DuckDBCredentials): Promise<DuckDBInstanceType> {
	const key = configKey(config);
	if (cachedInstance?.key === key) return cachedInstance.instance;

	// Tear down the previous instance if the config changed mid-process — same
	// rationale as every other connector's pool/client teardown on replace.
	closeCachedInstance(cachedInstance);

	cachedInstance = {
		key,
		instance: (async () => {
			const { DuckDBInstance } = await loadDuckDBApi();
			const instance = await DuckDBInstance.create(config.path);
			if (config.setupSql) {
				const setupConnection = await instance.connect();
				try {
					await setupConnection.run(config.setupSql);
				} finally {
					setupConnection.disconnectSync();
				}
			}
			return instance;
		})()
	};
	registerShutdownHandler();
	return cachedInstance.instance;
}

// Raw BLOB/BIT bytes surface as Uint8Array from getRowObjectsJS(), but their
// jsType (see type-mapping.ts) is 'string' — coerce so the value actually
// matches its declared column type. Dates are left alone: they're also
// `typeof === 'object'` but normalizeDateRows knows how to handle a raw Date.
function toSerializable(value: unknown): unknown {
	if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
	return value;
}

export async function executeDuckDBQuery(
	sql: string,
	config: DuckDBCredentials
): Promise<QueryResult> {
	await ensureDuckdbNativeAddonAvailable();

	const instance = await getInstance(config);
	const connection: DuckDBNativeConnection = await instance.connect();
	try {
		const result = await connection.run(sql);
		const names = result.columnNames();
		const types = result.columnTypes();
		const columns: Column[] = names.map((name, i) => {
			const typeName = types[i]?.toString() ?? 'unknown';
			return { name, clickhouseType: typeName, jsType: getDuckDBToJsType(typeName) };
		});

		const rawRows = await result.getRowObjectsJS();
		const rows: Record<string, unknown>[] = rawRows.map((r) => {
			const row: Record<string, unknown> = {};
			for (const col of columns) row[col.name] = toSerializable(r[col.name]);
			return row;
		});

		const dateColumns = new Set(columns.filter((c) => c.jsType === 'date').map((c) => c.name));
		const numericColumns = new Set(columns.filter((c) => c.jsType === 'number').map((c) => c.name));
		normalizeDateRows(rows, dateColumns);
		normalizeNumericRows(rows, numericColumns);
		normalizeSparklineRows(rows, columns);

		return { rows, columns };
	} finally {
		connection.disconnectSync();
	}
}
