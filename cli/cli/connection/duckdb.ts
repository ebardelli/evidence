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
import { escapeAnsiStringLiteral } from '@evidence/core/sql-dialect/common';
import type { DuckDBCredentials } from '@evidence/core/connectors/duckdb/credentials';
import type { Column } from '@evidence/core/user-components/interfaces/query-service';
import type { QueryResult } from './types';
import { redactInterpolatedValues } from './load-config';
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
 * Raised for a request the locked instance refuses on purpose (bad statement,
 * timeout, oversized result) — carries the HTTP status `/api/query` should
 * answer with (run-query.ts reads `status`), and a message safe to show a
 * viewer: never parser internals.
 */
export class QueryRejectedError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'QueryRejectedError';
	}
}

const DEFAULT_QUERY_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_RESULT_ROWS = 100_000;
const DEFAULT_THREADS = 4;

// Unset `lock` follows the run mode: on for `evidence serve` (viewers reach
// this through /api/query), off for `evidence dev` (the author is the viewer).
// EVIDENCE_SERVE is set by the CLI entrypoint before anything runs a query.
function shouldLock(config: DuckDBCredentials): boolean {
	return config.lock ?? !!process.env.EVIDENCE_SERVE;
}

function sqlString(value: string): string {
	return `'${escapeAnsiStringLiteral(value)}'`;
}

// Where httpfs looks for a CA bundle (its own error lists these), with
// SSL_CERT_FILE taking precedence like OpenSSL. First one that exists wins.
const CA_BUNDLE_CANDIDATES = [
	'/etc/ssl/certs/ca-certificates.crt',
	'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
	'/etc/pki/tls/certs/ca-bundle.crt',
	'/etc/ssl/ca-bundle.pem',
	'/etc/ssl/cert.pem'
];

function findCaBundle(): string | undefined {
	const fromEnv = process.env.SSL_CERT_FILE;
	return [fromEnv, ...CA_BUNDLE_CANDIDATES].find((p): p is string => !!p && existsSync(p));
}

// Order matters: lock_configuration must come last, since after it no SET /
// RESET / PRAGMA (from setup or a viewer) can change any of the others. With
// enable_external_access off, DuckDB still permits paths under
// allowed_directories and refuses everything else — read_*, glob, COPY, ATTACH.
//
// Two things DuckDB reads lazily, on first use, would otherwise trip over the
// lock on the first remote query:
// - the secret manager loads persistent secrets from ~/.duckdb/stored_secrets
//   the first time any secret is looked up — `FROM duckdb_secrets()` forces
//   that load while access is still open;
// - httpfs reads the system CA bundle for its first HTTPS request — only that
//   one public file is allowed (DuckDB `allowed_paths` is exact files), never
//   the rest of its directory.
function lockStatements(config: DuckDBCredentials): string[] {
	const allowed = (config.allowedPaths ?? []).map(sqlString).join(', ');
	const caBundle = findCaBundle();
	return [
		'FROM duckdb_secrets()',
		`SET allowed_directories = [${allowed}]`,
		`SET allowed_paths = [${caBundle ? sqlString(caBundle) : ''}]`,
		'SET autoinstall_known_extensions = false',
		'SET autoload_known_extensions = false',
		'SET allow_community_extensions = false',
		'SET allow_unredacted_secrets = false',
		'SET enable_external_access = false',
		'SET lock_configuration = true'
	];
}

/**
 * One cached in-process DuckDB instance per unique config — reused across
 * queries in this process so `:memory:` state (and anything setupSql
 * ATTACHed) survives between queries, same rationale as motherduck.ts's
 * cached pool. Each query opens (and closes) its own connection from it.
 */
let cachedInstance: { key: string; instance: Promise<DuckDBInstanceType> } | null = null;
let shutdownHandlerRegistered = false;
let unlockedWarningLogged = false;

function configKey(c: DuckDBCredentials): string {
	return JSON.stringify([
		c.path,
		c.setupSql,
		shouldLock(c),
		c.allowedPaths ?? [],
		c.memoryLimit,
		c.threads
	]);
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

async function createInstance(config: DuckDBCredentials): Promise<DuckDBInstanceType> {
	const { DuckDBInstance } = await loadDuckDBApi();
	const instance = await DuckDBInstance.create(config.path);
	const lock = shouldLock(config);
	if (!lock && config.lock === false && process.env.EVIDENCE_SERVE && !unlockedWarningLogged) {
		unlockedWarningLogged = true;
		console.warn(
			'connection.yaml: `lock: false` — viewer queries can read and write files, load extensions and change DuckDB settings.'
		);
	}

	const setupConnection = await instance.connect();
	try {
		// Sizing and caching first, so setup_sql's ATTACHes and loads already run
		// with them (setup_sql may still override). The external file cache keeps
		// remote file blocks (gs://, s3://) in memory across queries.
		if (config.memoryLimit) await setupConnection.run(`SET memory_limit = ${sqlString(config.memoryLimit)}`);
		await setupConnection.run(`SET threads = ${Math.floor(config.threads ?? DEFAULT_THREADS)}`);
		await setupConnection.run('SET enable_external_file_cache = true');
		if (config.setupSql) {
			try {
				await setupConnection.run(config.setupSql);
			} catch (e) {
				// DuckDB errors can quote the failing setup_sql text, secrets and
				// all. `${VAR}` values are scrubbed, but a literal one (inline, or
				// from setup_sql_path, which isn't interpolated) can't be told
				// apart — so in serve mode, where this error is cached and becomes
				// every viewer's /api/query response, the detail only goes to the
				// server log.
				const detail = `setup_sql failed: ${redactInterpolatedValues((e as Error).message)}`;
				if (!process.env.EVIDENCE_SERVE) throw new Error(detail);
				console.error(detail);
				throw new Error('setup_sql failed (details in the server log)');
			}
		}
		if (lock) {
			for (const statement of lockStatements(config)) await setupConnection.run(statement);
		}
	} catch (e) {
		// Never hand out an instance that's half set up or unlocked: close it,
		// and let the rejected promise stay cached so every later query fails too.
		setupConnection.disconnectSync();
		instance.closeSync();
		throw e;
	}
	setupConnection.disconnectSync();
	return instance;
}

async function getInstance(config: DuckDBCredentials): Promise<DuckDBInstanceType> {
	const key = configKey(config);
	if (cachedInstance?.key === key) return cachedInstance.instance;

	// Tear down the previous instance if the config changed mid-process — same
	// rationale as every other connector's pool/client teardown on replace.
	closeCachedInstance(cachedInstance);

	cachedInstance = { key, instance: createInstance(config) };
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

function notSingleSelect(): QueryRejectedError {
	return new QueryRejectedError('Only single SELECT statements are allowed', 400);
}

// json_serialize_sql parses without binding, and reports any non-SELECT as
// error_type "not implemented" ("Only SELECT statements can be serialized").
async function isNonSelect(connection: DuckDBNativeConnection, sql: string): Promise<boolean> {
	const result = await connection.run(`SELECT json_serialize_sql(${sqlString(sql)}) AS j`);
	const [row] = await result.getRowObjectsJS();
	const parsed = JSON.parse(String(row?.j)) as { error?: boolean; error_type?: string };
	return parsed.error === true && parsed.error_type === 'not implemented';
}

/**
 * Only asked once a wrapped query has already failed, to pick its error
 * message — never what decides whether SQL runs. Statements like
 * `INSTALL httpfs` or `DETACH memory` still parse inside the wrapper, as a
 * parenthesized table and its alias, and fail binding with a puzzling
 * "Table … does not exist". json_serialize_sql flags them, but flags PIVOT the
 * same way, so both texts are asked: a refused statement is a non-SELECT on
 * its own but serializes once wrapped (it became a table reference); PIVOT is
 * flagged either way.
 */
async function isRefusedStatement(
	connection: DuckDBNativeConnection,
	sql: string,
	wrapped: string
): Promise<boolean> {
	try {
		return (await isNonSelect(connection, sql)) && !(await isNonSelect(connection, wrapped));
	} catch {
		return false;
	}
}

/**
 * Locked instances accept exactly one SELECT, run as
 * `FROM (<sql>) LIMIT <maxRows + 1>`. Defence in depth: the lock settings are
 * what actually stop file access (a SELECT can still call table functions),
 * this just refuses DDL/DML/ATTACH/SET/… before they reach it.
 *
 * The wrapper is the whole check, and fails closed: only a query (SELECT,
 * FROM-first, PIVOT, DESCRIBE, SUMMARIZE, …) parses as a subquery, and text
 * that parses as exactly one statement beginning `FROM (` is a SELECT however
 * the viewer's SQL tries to close the parenthesis early. Anything that doesn't
 * parse never runs. The LIMIT also bounds what run() materializes, so
 * max_result_rows caps memory, not just the response.
 *
 * Parser only, never a prepared statement: preparing measured ~1.5s slower per
 * query on the remote warehouse than a plain run().
 */
async function lockedQuerySql(
	connection: DuckDBNativeConnection,
	sql: string,
	maxRows: number
): Promise<string> {
	const rejected = notSingleSelect();
	// The C API reads SQL only up to a NUL, so text after one would be parsed
	// and run as something other than what was sent.
	if (sql.includes('\0')) throw rejected;
	// Leading text on the same line keeps DuckDB's LINE numbers matching the
	// viewer's SQL; the closing newline ends any trailing `--` comment.
	const wrapped = `FROM (${sql.replace(/[\s;]+$/, '')}\n) LIMIT ${maxRows + 1}`;
	let count: number;
	try {
		count = (await connection.extractStatements(wrapped)).count;
	} catch {
		// A syntax error in the SQL as sent is the viewer's to see; SQL that
		// parses on its own but not as a subquery is a statement we refuse.
		try {
			await connection.extractStatements(sql);
		} catch (e) {
			throw new Error((e as Error).message.replace(/^Failed to extract statements: /, ''));
		}
		throw rejected;
	}
	if (count !== 1) throw rejected;
	return wrapped;
}

export async function executeDuckDBQuery(
	sql: string,
	config: DuckDBCredentials
): Promise<QueryResult> {
	await ensureDuckdbNativeAddonAvailable();

	const instance = await getInstance(config);
	const connection: DuckDBNativeConnection = await instance.connect();
	const locked = shouldLock(config);
	const maxRows = config.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS;
	let timedOut = false;
	const timer = locked
		? setTimeout(
				() => {
					timedOut = true;
					connection.interrupt();
				},
				(config.queryTimeoutSeconds ?? DEFAULT_QUERY_TIMEOUT_SECONDS) * 1000
			)
		: undefined;
	let wrapped: string | undefined;
	try {
		if (locked) wrapped = await lockedQuerySql(connection, sql, maxRows);
		const result = await connection.run(wrapped ?? sql);
		// The wrapper's LIMIT fetches one row past the cap, so a result that
		// would have been truncated is refused instead. Not a streaming reader:
		// streaming (like prepared execution) was measurably slower.
		if (locked && result.rowCount > maxRows) {
			throw new QueryRejectedError(
				`Query returned more than ${maxRows} rows (max_result_rows)`,
				413
			);
		}
		const names = result.columnNames();
		const typeNames = result.columnTypes().map((t) => t?.toString() ?? 'unknown');
		const rawRows = await result.getRowObjectsJS();

		const columns: Column[] = names.map((name, i) => {
			const typeName = typeNames[i] ?? 'unknown';
			return { name, clickhouseType: typeName, jsType: getDuckDBToJsType(typeName) };
		});

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
	} catch (e) {
		if (timedOut) throw new QueryRejectedError('Query timed out (query_timeout_seconds)', 504);
		if (
			wrapped &&
			!(e instanceof QueryRejectedError) &&
			(await isRefusedStatement(connection, sql, wrapped))
		) {
			throw notSingleSelect();
		}
		throw e;
	} finally {
		clearTimeout(timer);
		connection.disconnectSync();
	}
}
