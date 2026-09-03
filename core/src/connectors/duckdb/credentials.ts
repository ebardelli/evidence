/**
 * Execution-layer DuckDB credentials, resolved from connection.yaml (CLI) or
 * the Studio vault secret + org-settings config. Native DuckDB has no
 * server/auth — `path` is either `:memory:` or a filesystem path to a local
 * `.duckdb` file, opened in-process. `setupSql` (already read from
 * `setup_sql`/`setup_sql_path` by resolve.ts) runs once when the client
 * starts, and `schemas` is the optional schema-browser allowlist.
 */
export type DuckDBCredentials = {
	path: string;
	/** Allowlist of schemas exposed to the schema browser; empty/absent = all non-system. */
	schemas?: string[];
	/** SQL run once when the client starts — INSTALL/LOAD extensions, ATTACH, etc. */
	setupSql?: string;
};

// Assert the load-bearing keys so a corrupted secret fails readably, not deep in
// the driver. Mirrors motherduck/credentials.ts.
export function normalizeCredentials(raw: unknown): DuckDBCredentials {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		throw new Error('DuckDB credentials are missing or invalid');
	}
	const c = raw as Partial<DuckDBCredentials> & Record<string, unknown>;
	if (!c.path || typeof c.path !== 'string') {
		throw new Error('DuckDB credentials are missing "path"');
	}
	return {
		path: c.path,
		schemas: Array.isArray(c.schemas) ? (c.schemas as string[]) : [],
		setupSql: typeof c.setupSql === 'string' ? c.setupSql : undefined
	};
}
