import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeDuckDBQuery, QueryRejectedError } from './duckdb';
import type { DuckDBCredentials } from '@evidence/core/connectors/duckdb/credentials';

let allowedDir: string;
let outsideDir: string;

beforeAll(async () => {
	allowedDir = await mkdtemp(path.join(os.tmpdir(), 'evd-duckdb-allowed-'));
	outsideDir = await mkdtemp(path.join(os.tmpdir(), 'evd-duckdb-outside-'));
	await writeFile(path.join(allowedDir, 'ok.csv'), 'a,b\n1,2\n');
	await writeFile(path.join(outsideDir, 'secret.csv'), 'a,b\n3,4\n');
	await writeFile(path.join(outsideDir, '.env'), 'TOKEN=shh\n');
});

afterAll(async () => {
	await rm(allowedDir, { recursive: true, force: true });
	await rm(outsideDir, { recursive: true, force: true });
});

afterEach(() => {
	delete process.env.EVIDENCE_SERVE;
});

// Each config gets its own setupSql comment so tests never share a cached
// instance (the cache is keyed on config, one instance per process).
let seq = 0;
function locked(extra: Partial<DuckDBCredentials> = {}): DuckDBCredentials {
	return {
		path: ':memory:',
		setupSql: `-- test ${seq++}\nCREATE TABLE t AS SELECT range AS n FROM range(10);`,
		allowedPaths: [allowedDir],
		lock: true,
		...extra
	};
}

async function rejection(sql: string, config: DuckDBCredentials): Promise<unknown> {
	return executeDuckDBQuery(sql, config).then(
		() => {
			throw new Error(`expected query to fail: ${sql}`);
		},
		(e: unknown) => e
	);
}

describe('locked DuckDB instance', () => {
	it('still reads tables created by setup_sql', async () => {
		const result = await executeDuckDBQuery('select count(*) as c from t', locked());
		expect(Number(result.rows[0]?.c)).toBe(10);
	});

	it('reads files under allowed_paths', async () => {
		const result = await executeDuckDBQuery(
			`select * from read_csv('${path.join(allowedDir, 'ok.csv')}')`,
			locked()
		);
		expect(result.rows).toHaveLength(1);
	});

	it.each([
		['read_text', (d: string) => `select * from read_text('${path.join(d, '.env')}')`],
		['read_blob', (d: string) => `select * from read_blob('${path.join(d, '.env')}')`],
		['glob', (d: string) => `select * from glob('${d}/*')`],
		['read_csv', (d: string) => `select * from read_csv('${path.join(d, 'secret.csv')}')`]
	])('refuses %s outside allowed_paths', async (_name, build) => {
		const e = await rejection(build(outsideDir), locked());
		expect(e).toBeInstanceOf(Error);
		expect(e).not.toBeInstanceOf(QueryRejectedError);
	});

	it.each([
		'SET enable_external_access = true',
		'RESET lock_configuration',
		"PRAGMA enable_profiling",
		`COPY (select 1) TO '${'/tmp/evd-x.csv'}'`,
		"ATTACH ':memory:' AS other",
		'DETACH memory',
		'INSTALL httpfs',
		'LOAD httpfs',
		'CREATE TEMP TABLE x AS SELECT 1',
		"CREATE SECRET s (TYPE s3, KEY_ID 'k', SECRET 'v')",
		'select 1; select 2',
		// The C API stops at a NUL, so this would otherwise run as `DROP TABLE t`.
		'DROP TABLE t\0',
		'select 1\0; DROP TABLE t',
		// Closing the wrapper's parenthesis early to smuggle in a second statement.
		'select 1); DROP TABLE t; select * from (select 1',
		'EXPLAIN select 1'
	])('rejects %s with 400', async (sql) => {
		const config = locked();
		const e = await rejection(sql, config);
		expect(e).toBeInstanceOf(QueryRejectedError);
		expect((e as QueryRejectedError).status).toBe(400);
		expect((e as Error).message).toBe('Only single SELECT statements are allowed');
		const result = await executeDuckDBQuery('select count(*) as c from t', config);
		expect(Number(result.rows[0]?.c)).toBe(10);
	});

	it.each([
		'PIVOT t ON (n % 2) USING count(*)',
		'from (PIVOT t ON (n % 2) USING count(*))',
		'UNPIVOT (select 1 a, 2 b) ON a, b INTO NAME k VALUE v',
		'DESCRIBE t',
		'SUMMARIZE t',
		'from t select n',
		'select n from t;',
		'select n from t -- trailing comment'
	])('runs %s', async (sql) => {
		const result = await executeDuckDBQuery(sql, locked());
		expect(result.rows.length).toBeGreaterThan(0);
	});

	it('keeps the query’s own ORDER BY and LIMIT', async () => {
		const result = await executeDuckDBQuery('select n from t order by n desc limit 3', locked());
		expect(result.rows.map((r) => Number(r.n))).toEqual([9, 8, 7]);
	});

	it('reports a syntax error as the viewer’s error, not a refusal', async () => {
		const e = await rejection('selec 1', locked());
		expect(e).not.toBeInstanceOf(QueryRejectedError);
		expect((e as Error).message).toMatch(/^Parser Error: syntax error at or near "selec"/);
	});

	it('loads the secret store before locking, so secret lookups still work', async () => {
		const result = await executeDuckDBQuery('select count(*) as c from duckdb_secrets()', locked());
		expect(result.rows).toHaveLength(1);
	});

	it('allows the system CA bundle file (for httpfs), but not its directory', async () => {
		const bundle = [
			'/etc/ssl/certs/ca-certificates.crt',
			'/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
			'/etc/pki/tls/certs/ca-bundle.crt',
			'/etc/ssl/ca-bundle.pem',
			'/etc/ssl/cert.pem'
		].find((p) => existsSync(p));
		if (!bundle) return;
		const config = locked();
		await expect(
			executeDuckDBQuery(`select count(*) from read_text('${bundle}')`, config)
		).resolves.toBeDefined();
		await expect(
			executeDuckDBQuery(`select * from glob('${path.dirname(bundle)}/*')`, config)
		).rejects.toThrow(/Permission Error/);
	});

	it('refuses unredacted secrets', async () => {
		const e = await rejection('select * from duckdb_secrets(redact := false)', locked());
		expect(e).toBeInstanceOf(Error);
	});

	it('returns 413 past max_result_rows', async () => {
		const e = await rejection('select * from range(50)', locked({ maxResultRows: 20 }));
		expect((e as QueryRejectedError).status).toBe(413);
	});

	it('returns exactly max_result_rows without error', async () => {
		const result = await executeDuckDBQuery(
			'select * from range(20)',
			locked({ maxResultRows: 20 })
		);
		expect(result.rows).toHaveLength(20);
	});

	it('interrupts a query past query_timeout_seconds with 504', async () => {
		const e = await rejection(
			'select count(*) from range(100000000) a, range(100000) b',
			locked({ queryTimeoutSeconds: 0.2 })
		);
		expect((e as QueryRejectedError).status).toBe(504);
	});

	it('never falls back to an unlocked instance when setup fails', async () => {
		const config = locked({ setupSql: `-- broken ${seq++}\nTHIS IS NOT SQL` });
		await expect(executeDuckDBQuery('select 1', config)).rejects.toThrow(/setup_sql failed/);
		await expect(executeDuckDBQuery('select 1', config)).rejects.toThrow(/setup_sql failed/);
	});

	it('keeps setup_sql error detail out of query responses in serve mode', async () => {
		process.env.EVIDENCE_SERVE = '1';
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const config = locked({
				setupSql: `-- broken ${seq++}\nCREATE SECRET (TYPE gcs, KEY_ID 'id', SECRET 'literal-s3cr3t') oops`
			});
			const e = await rejection('select 1', config);
			expect((e as Error).message).toBe('setup_sql failed (details in the server log)');
			expect(String(error.mock.calls[0]?.[0])).toMatch(/^setup_sql failed: /);
		} finally {
			error.mockRestore();
		}
	});

	it('locks by default in serve mode', async () => {
		process.env.EVIDENCE_SERVE = '1';
		const e = await rejection('SET threads = 1', locked({ lock: undefined }));
		expect(e).toBeInstanceOf(QueryRejectedError);
	});
});

describe('unlocked DuckDB instance', () => {
	it('keeps today’s behaviour with lock: false (and by default in dev mode)', async () => {
		for (const lock of [false, undefined]) {
			const config = locked({ lock });
			const result = await executeDuckDBQuery(
				`select count(*) as c from read_csv('${path.join(outsideDir, 'secret.csv')}')`,
				config
			);
			expect(Number(result.rows[0]?.c)).toBe(1);
			await expect(executeDuckDBQuery('select 1; select 2', config)).resolves.toBeDefined();
		}
	});
});
