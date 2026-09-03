import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DuckDBConnection } from './connection-schema';
import type { DuckDBCredentials } from './credentials';

export type ResolveOpts = {
	/** Base directory `path` and `setup_sql_path` resolve relative to. */
	cwd: string;
};

/**
 * Config layer → execution layer. Reads `setup_sql_path` to a string at the
 * trust boundary (mirrors postgres/resolve.ts reading ssl_*_path) so the
 * executor receives a single ready-to-run `setupSql`. `path` is resolved
 * relative to connection.yaml unless it's the `:memory:` sentinel or already
 * absolute — DuckDB's own CLI/driver treats a bare relative path as relative
 * to the process cwd, not the config file, so this normalizes that.
 */
export async function resolveDuckDBCredentials(
	config: DuckDBConnection,
	opts: ResolveOpts
): Promise<DuckDBCredentials> {
	let setupSql = config.setup_sql;
	if (config.setup_sql_path) {
		const resolved = path.isAbsolute(config.setup_sql_path)
			? config.setup_sql_path
			: path.join(opts.cwd, config.setup_sql_path);
		try {
			setupSql = await readFile(resolved, 'utf-8');
		} catch (e) {
			throw new Error(
				`failed to read setup_sql_path "${config.setup_sql_path}": ${(e as Error).message}`
			);
		}
	}

	const dbPath =
		config.path === ':memory:' || path.isAbsolute(config.path)
			? config.path
			: path.join(opts.cwd, config.path);

	return {
		path: dbPath,
		schemas: config.schemas,
		setupSql
	};
}
