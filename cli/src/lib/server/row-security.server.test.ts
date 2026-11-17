import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { runQuery } from './run-query';
import { deserialize, filterTemplate, parseSelect, type JsonNode } from './row-filter-sql';

vi.mock('./run-query', () => ({ runQuery: vi.fn() }));
vi.mock('$lib/auth/credentials.server', () => ({ loadCredentials: async () => null }));
vi.mock('./row-filter-sql', async (importOriginal) => ({
	...(await importOriginal<typeof import('./row-filter-sql')>()),
	parseSelect: vi.fn(),
	filterTemplate: vi.fn(),
	deserialize: vi.fn()
}));

import {
	assertPageAccess,
	authorizeQuery,
	pagesWithLegacyAuth,
	resetRowSecurityCaches,
	substituteViewer
} from './row-security.server';
import { getMarkdownFile } from '$lib/markdown/files.server';

const ROSTER = `---
auth:
  rows:
    students: school_id in (select school_id from staff where email = {{ $user.email }})
  tables: [schools]
  message: "{email} has no students"
---
# Roster
`;

const DIRECTORY = `---
auth:
  tables: [main.schools, students]
---
# Directory
`;

const table = (table_name: string): JsonNode => ({
	type: 'BASE_TABLE',
	alias: '',
	table_name,
	schema_name: '',
	catalog_name: '',
	column_name_alias: []
});
const select = (from_table: JsonNode, extra: JsonNode = {}): JsonNode => ({
	node: { type: 'SELECT_NODE', cte_map: { map: [] }, from_table, ...extra }
});
const TEMPLATE: JsonNode = {
	type: 'SUBQUERY',
	alias: 't',
	subquery: { node: { type: 'SELECT_NODE', from_table: table('t'), where_clause: 'P' } }
};

let filtered: string;
let plain: string;
const ENV_KEYS = [
	'EVIDENCE_PROJECT_CWD',
	'EVIDENCE_SERVE',
	'EVIDENCE_AUTH_PROXY_EMAIL_HEADER',
	'EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER',
	'EVIDENCE_AUTH_PROXY_JWT_JWKS_URL'
];
let savedEnv: [string, string | undefined][];

async function project(pages: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'evd-row-security-'));
	await mkdir(path.join(dir, 'pages'));
	await writeFile(
		path.join(dir, 'evidence.config.yaml'),
		`project:\n  name: T\n  evidence: '0.4.6'\npages: ./pages\n`
	);
	for (const [name, content] of Object.entries(pages)) {
		await writeFile(path.join(dir, 'pages', `${name}.md`), content);
	}
	return dir;
}

beforeAll(async () => {
	filtered = await project({ roster: ROSTER, directory: DIRECTORY, other: '# Other\n' });
	plain = await project({ home: '# Home\n' });
});
afterAll(async () => {
	await rm(filtered, { recursive: true, force: true });
	await rm(plain, { recursive: true, force: true });
});

beforeEach(() => {
	savedEnv = ENV_KEYS.map((k) => [k, process.env[k]]);
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.EVIDENCE_PROJECT_CWD = filtered;
	process.env.EVIDENCE_SERVE = '1';
	process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Email';
	process.env.EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER = 'true';
	resetRowSecurityCaches();
	// The page gate: alice has rows, everyone else doesn't.
	vi.mocked(runQuery)
		.mockReset()
		.mockImplementation(async (sql: string) => ({
			rows: sql.includes("'alice@x.org'") ? [{ ok: 1 }] : [],
			columns: []
		}));
	vi.mocked(parseSelect).mockReset();
	vi.mocked(filterTemplate).mockReset().mockResolvedValue(TEMPLATE);
	vi.mocked(deserialize).mockReset().mockResolvedValue('REWRITTEN');
});
afterEach(() => {
	for (const [k, v] of savedEnv) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const as = (email?: string) => new Headers(email ? { 'X-Email': email } : {});
const parsesTo = (statement: JsonNode) =>
	vi.mocked(parseSelect).mockResolvedValue({ ok: true, statement });

describe('substituteViewer', () => {
	const viewer = { id: "o'neil@x.org", email: "o'neil@x.org", firstName: null };

	it('inserts the email as an escaped literal, absorbing surrounding quotes', () => {
		expect(substituteViewer('email = {{ $user.email }}', viewer)).toBe("email = 'o''neil@x.org'");
		expect(substituteViewer("email = '{{$user.email}}'", viewer)).toBe("email = 'o''neil@x.org'");
		expect(substituteViewer('n = {{ $user.first_name }}', viewer)).toBe('n = NULL');
	});

	it('rejects unknown variables', () => {
		expect(() => substituteViewer('{{ $user.role }}', viewer)).toThrow(/\$user\.role/);
	});
});

describe('authorizeQuery', () => {
	it('passes SQL through untouched when no page has row filters', async () => {
		process.env.EVIDENCE_PROJECT_CWD = plain;
		expect(await authorizeQuery(undefined, 'select * from anything', as())).toEqual({
			ok: true,
			sql: 'select * from anything'
		});
		expect(parseSelect).not.toHaveBeenCalled();
	});

	it('requires an existing page once filters exist', async () => {
		expect(await authorizeQuery(undefined, 'select 1', as('alice@x.org'))).toMatchObject({ status: 400 });
		expect(await authorizeQuery('nope', 'select 1', as('alice@x.org'))).toMatchObject({ status: 404 });
	});

	it('rewrites reads of a filtered table with the viewer substituted', async () => {
		parsesTo(select(table('students')));
		expect(await authorizeQuery('/roster/', 'select * from students', as('alice@x.org'))).toEqual({
			ok: true,
			sql: 'REWRITTEN'
		});
		expect(filterTemplate).toHaveBeenCalledWith(
			"(school_id in (select school_id from staff where email = 'alice@x.org'))"
		);
		const rewritten = vi.mocked(deserialize).mock.calls[0]![0];
		expect((rewritten.node as JsonNode).from_table).toMatchObject({
			type: 'SUBQUERY',
			alias: 'students',
			subquery: { node: { from_table: { table_name: 'students' }, where_clause: 'P' } }
		});
	});

	it('leaves queries that read no filtered table alone', async () => {
		parsesTo(select(table('schools')));
		expect(await authorizeQuery('roster', 'select * from schools', as('alice@x.org'))).toEqual({
			ok: true,
			sql: 'select * from schools'
		});
		expect(deserialize).not.toHaveBeenCalled();
	});

	it('refuses tables the page does not declare', async () => {
		parsesTo(select(table('teachers')));
		expect(await authorizeQuery('roster', 'select * from teachers', as('alice@x.org'))).toEqual({
			ok: false,
			status: 403,
			error: "Table teachers is not declared in this page's auth.tables."
		});
		// A page with no auth block can read no tables at all.
		parsesTo(select(table('schools')));
		expect(await authorizeQuery('other', 'select * from schools', as())).toMatchObject({ status: 403 });
		// Tables inside the server's own predicates (staff) aren't readable directly.
		parsesTo(select(table('staff')));
		expect(await authorizeQuery('roster', 'select * from staff', as('alice@x.org'))).toMatchObject({
			status: 403
		});
	});

	it('checks every table reference, not just the first', async () => {
		parsesTo(select(table('schools'), { where_clause: { subquery: select(table('teachers')) } }));
		expect(await authorizeQuery('roster', 'select …', as('alice@x.org'))).toMatchObject({ status: 403 });
	});

	it('lets a page without filters read its declared tables', async () => {
		parsesTo(select({ ...table('schools'), schema_name: 'main' }));
		expect(await authorizeQuery('directory', 'select * from main.schools', as())).toEqual({
			ok: true,
			sql: 'select * from main.schools'
		});
		parsesTo(select({ ...table('schools'), schema_name: 'other' }));
		expect(await authorizeQuery('directory', 'select * from other.schools', as())).toMatchObject({
			status: 403
		});
		parsesTo(select({ type: 'TABLE_FUNCTION', function: { function_name: 'range' } }));
		expect(await authorizeQuery('other', 'select * from range(3)', as())).toMatchObject({ ok: true });
	});

	it("still refuses another page's filtered table even when declared", async () => {
		parsesTo(select(table('students')));
		expect(await authorizeQuery('directory', 'select * from students', as())).toEqual({
			ok: false,
			status: 403,
			error: 'Query not permitted on this page.'
		});
	});

	it('refuses a filtered table from a page without that filter', async () => {
		parsesTo(select(table('students')));
		expect(await authorizeQuery('other', 'select * from students', as('alice@x.org'))).toMatchObject({
			ok: false,
			status: 403
		});
	});

	it('refuses a CTE that shadows a filtered table, and by-name table functions', async () => {
		parsesTo(select(table('students'), { cte_map: { map: [{ key: 'Students' }] } }));
		expect(await authorizeQuery('roster', 'with …', as('alice@x.org'))).toMatchObject({ status: 403 });

		parsesTo(select({ type: 'TABLE_FUNCTION', function: { function_name: 'query_table' } }));
		expect(await authorizeQuery('other', "from query_table('students')", as('alice@x.org'))).toMatchObject({
			status: 403,
			error: expect.stringContaining('query_table')
		});
	});

	it('returns 400 for anything but a single SELECT', async () => {
		vi.mocked(parseSelect).mockResolvedValue({ ok: false, reason: 'not-select', message: 'Only single SELECT statements are allowed' });
		expect(await authorizeQuery('roster', 'drop table students', as('alice@x.org'))).toMatchObject({ status: 400 });
	});

	it("gives a viewer with no rows the page's denial message", async () => {
		expect(await authorizeQuery('roster', 'select 1', as('bob@x.org'))).toEqual({
			ok: false,
			status: 403,
			error: 'bob@x.org has no students'
		});
		expect(parseSelect).not.toHaveBeenCalled();
	});
});

describe('pagesWithLegacyAuth', () => {
	it('finds pages still using auth.users / auth.query', async () => {
		const dir = await project({
			old: '---\nauth:\n  users: [a@x.org]\n---\n# Old\n',
			roster: ROSTER
		});
		try {
			expect(await pagesWithLegacyAuth(dir)).toEqual(['old']);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('assertPageAccess', () => {
	it('allows viewers with rows and pages without filters', async () => {
		const roster = (await getMarkdownFile(filtered, 'roster'))!;
		const other = (await getMarkdownFile(filtered, 'other'))!;
		await expect(assertPageAccess(roster, as('alice@x.org'))).resolves.toBeUndefined();
		await expect(assertPageAccess(other, as())).resolves.toBeUndefined();
	});

	it('403s a viewer with no rows, or no identity', async () => {
		const roster = (await getMarkdownFile(filtered, 'roster'))!;
		await expect(assertPageAccess(roster, as('bob@x.org'))).rejects.toMatchObject({
			status: 403,
			body: { message: 'bob@x.org has no students' }
		});
		await expect(assertPageAccess(roster, as())).rejects.toMatchObject({ status: 403 });
	});

	it('500s when the filter itself fails', async () => {
		vi.mocked(runQuery).mockResolvedValue({ rows: [], columns: [], error: 'no such table: staff' });
		const roster = (await getMarkdownFile(filtered, 'roster'))!;
		await expect(assertPageAccess(roster, as('alice@x.org'))).rejects.toMatchObject({ status: 500 });
	});
});
