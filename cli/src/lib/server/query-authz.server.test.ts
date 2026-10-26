import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { runQuery } from './run-query';

vi.mock('./run-query', () => ({ runQuery: vi.fn() }));
vi.mock('$lib/auth/credentials.server', () => ({ loadCredentials: async () => null }));

import { authorizeQuery, resetQueryAuthzCaches } from './query-authz.server';

/**
 * Stand-in for DuckDB's json_serialize_sql, good enough for the SQL these
 * tests send: tables are the identifiers after FROM/JOIN, a `name(` after
 * FROM is a table function, anything not starting with SELECT/WITH is a
 * non-SELECT statement.
 */
function fakeSerialize(sql: string): unknown {
	const trimmed = sql.trim().replace(/;\s*$/, '');
	if (!/^(select|with)\b/i.test(trimmed)) {
		return { error: true, error_type: 'not implemented', error_message: 'Only SELECT' };
	}
	if (trimmed.includes(';')) return { error: false, statements: [{}, {}] };
	const from: unknown[] = [];
	for (const match of trimmed.matchAll(/\b(?:from|join)\s+([A-Za-z_"][\w."]*)(\s*\()?/gi)) {
		const ident = match[1]!;
		if (match[2]) {
			from.push({ type: 'TABLE_FUNCTION', function: { function_name: ident } });
			continue;
		}
		const parts = ident.split('.').map((p) => p.replace(/"/g, ''));
		const [table_name, schema_name = '', catalog_name = ''] = parts.reverse();
		from.push({ type: 'BASE_TABLE', table_name, schema_name, catalog_name });
	}
	return { error: false, statements: [{ node: { type: 'SELECT_NODE', from } }] };
}

function mockWarehouse() {
	vi.mocked(runQuery).mockImplementation(async (sql: string) => {
		const serialize = sql.match(/^SELECT json_serialize_sql\('([\s\S]*)'\) AS j$/);
		if (serialize) {
			const inner = serialize[1]!.replace(/''/g, "'");
			return { rows: [{ j: JSON.stringify(fakeSerialize(inner)) }], columns: [{ name: 'j' } as never] };
		}
		if (/SELECT DISTINCT/.test(sql)) {
			return { rows: [{ v: 'term_a' }, { v: 'term_b' }], columns: [{ name: 'v' } as never] };
		}
		return { rows: [], columns: [] };
	});
}

const HOME = `# Home

\`\`\`sql orders
select * from shop.orders
\`\`\`

\`\`\`sql top_orders
select * from {{orders}} limit 5
\`\`\`

{% dropdown id="db" options=["s1", "s2"] /%}

\`\`\`sql students
select * from {{db.literal}}.stu
\`\`\`

\`\`\`sql terms
select term from shop.terms
\`\`\`

{% dropdown id="term" data="terms" value_column="term" /%}

\`\`\`sql by_term
select * from {{term.literal}}.enrollment
\`\`\`
`;

const SECRET = `---
auth:
  users: [boss@example.com]
  message: "{email} may not see incidents."
---

\`\`\`sql incidents
select * from wh.ads
\`\`\`
`;

let projectDir: string;
const ENV_KEYS = [
	'EVIDENCE_PROJECT_CWD',
	'EVIDENCE_AUTH_PROXY_EMAIL_HEADER',
	'EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER',
	'EVIDENCE_AUTH_PROXY_JWT_JWKS_URL',
	'EVIDENCE_SERVE'
] as const;
let savedEnv: [string, string | undefined][];

beforeAll(async () => {
	projectDir = await mkdtemp(path.join(tmpdir(), 'evd-query-authz-'));
	await mkdir(path.join(projectDir, 'pages'));
	await writeFile(
		path.join(projectDir, 'evidence.config.yaml'),
		`project:\n  name: Authz Test\n  evidence: '0.4.6'\npages: ./pages\n`
	);
	await writeFile(
		path.join(projectDir, 'connection.yaml'),
		`type: motherduck\ntoken: test-token\ndatabase: test_db\n`
	);
	await writeFile(path.join(projectDir, 'pages', 'home.md'), HOME);
	await writeFile(path.join(projectDir, 'pages', 'secret.md'), SECRET);
});

afterAll(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

beforeEach(() => {
	savedEnv = ENV_KEYS.map((k) => [k, process.env[k]]);
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.EVIDENCE_PROJECT_CWD = projectDir;
	process.env.EVIDENCE_SERVE = '1';
	process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
	process.env.EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER = 'true';
	resetQueryAuthzCaches();
	vi.mocked(runQuery).mockReset();
	mockWarehouse();
});

afterEach(() => {
	for (const [k, v] of savedEnv) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const as = (email?: string) => new Headers(email ? { 'X-Auth-Request-Email': email } : {});

describe('authorizeQuery', () => {
	it('allows a component wrapper around a page query', async () => {
		const sql = `SELECT count(*) FROM (SELECT * FROM (select * from shop.orders) "__ev_inline_orders" WHERE true)`;
		expect(await authorizeQuery('', sql, as('jane@example.com'))).toEqual({ ok: true });
	});

	it('allows the information_schema catalog queries components make', async () => {
		const sql = `SELECT table_schema FROM information_schema.columns`;
		expect(await authorizeQuery('', sql, as('jane@example.com'))).toEqual({ ok: true });
	});

	it('refuses a table the page does not read', async () => {
		const result = await authorizeQuery('', 'select * from wh.ads', as('jane@example.com'));
		expect(result).toMatchObject({ ok: false, status: 403 });
	});

	it('refuses a table function the page does not use', async () => {
		const result = await authorizeQuery('', "select * from read_text('/project/.env')", as('jane@example.com'));
		expect(result).toMatchObject({ ok: false, status: 403 });
	});

	it('allows each inline option of a .literal filter, and nothing else', async () => {
		const headers = as('jane@example.com');
		expect(await authorizeQuery('', 'select * from s1.stu', headers)).toEqual({ ok: true });
		expect(await authorizeQuery('', 'select * from s2.stu', headers)).toEqual({ ok: true });
		expect(await authorizeQuery('', 'select * from aeries.stu', headers)).toMatchObject({ status: 403 });
	});

	it('allows the values of a data-backed .literal filter', async () => {
		const headers = as('jane@example.com');
		expect(await authorizeQuery('', 'select * from term_b.enrollment', headers)).toEqual({ ok: true });
		expect(await authorizeQuery('', 'select * from term_z.enrollment', headers)).toMatchObject({
			status: 403
		});
	});

	it('rejects non-SELECT and multi-statement SQL with 400', async () => {
		const headers = as('jane@example.com');
		for (const sql of ["copy (select 1) to '/project/x.md'", 'select 1; select 2', 'SET threads = 1']) {
			expect(await authorizeQuery('', sql, headers)).toEqual({
				ok: false,
				status: 400,
				error: 'Only single SELECT statements are allowed'
			});
		}
	});

	it('returns 404 for an unknown page', async () => {
		expect(await authorizeQuery('nope', 'select 1', as('jane@example.com'))).toMatchObject({
			status: 404
		});
	});

	it("returns the page's own 403 when the viewer fails its auth:", async () => {
		expect(await authorizeQuery('secret', 'select * from wh.ads', as('jane@example.com'))).toEqual({
			ok: false,
			status: 403,
			error: 'jane@example.com may not see incidents.'
		});
	});

	it('lets an allowed viewer query the gated page', async () => {
		expect(await authorizeQuery('secret', 'select * from wh.ads', as('boss@example.com'))).toEqual({
			ok: true
		});
	});

	it('does not let a gated page’s tables be queried via another page', async () => {
		expect(await authorizeQuery('', 'select * from wh.ads', as('boss@example.com'))).toMatchObject({
			status: 403
		});
	});

	it('returns 401 with no identity when the project has auth: pages', async () => {
		expect(await authorizeQuery('', 'select * from shop.orders', as())).toMatchObject({
			status: 401
		});
	});

	it('returns 401 in plain-header mode without the trust opt-in', async () => {
		delete process.env.EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER;
		expect(
			await authorizeQuery('', 'select * from shop.orders', as('jane@example.com'))
		).toMatchObject({ status: 401 });
	});
});
