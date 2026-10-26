import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
		'select 1; select 2'
	])('rejects %s with 400', async (sql) => {
		const e = await rejection(sql, locked());
		expect(e).toBeInstanceOf(QueryRejectedError);
		expect((e as QueryRejectedError).status).toBe(400);
		expect((e as Error).message).toBe('Only single SELECT statements are allowed');
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
