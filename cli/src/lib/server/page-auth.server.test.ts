import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertPageAuthorized } from './page-auth.server';
import { runQuery } from './run-query';

vi.mock('./run-query', () => ({ runQuery: vi.fn() }));

const ENV_KEYS = ['EVIDENCE_AUTH_PROXY_EMAIL_HEADER', 'EVIDENCE_AUTH_PROXY_NAME_HEADER'] as const;

function saveEnv() {
	return ENV_KEYS.map((k) => [k, process.env[k]] as const);
}
function restoreEnv(saved: ReturnType<typeof saveEnv>) {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function headersWithEmail(email?: string) {
	return new Headers(email ? { 'X-Auth-Request-Email': email } : {});
}

function expectForbidden(promise: Promise<unknown>) {
	return expect(promise).rejects.toMatchObject({ status: 403 });
}

describe('assertPageAuthorized', () => {
	let saved: ReturnType<typeof saveEnv>;
	beforeEach(() => {
		saved = saveEnv();
		for (const k of ENV_KEYS) delete process.env[k];
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		vi.mocked(runQuery).mockReset();
	});
	afterEach(() => restoreEnv(saved));

	it('no-ops when auth is undefined', async () => {
		await expect(assertPageAuthorized(undefined, headersWithEmail())).resolves.toBeUndefined();
	});

	it('no-ops when auth has neither users nor a query', async () => {
		await expect(assertPageAuthorized({}, headersWithEmail())).resolves.toBeUndefined();
	});

	it('forbids when auth restricts the page but there is no proxy identity', async () => {
		await expectForbidden(
			assertPageAuthorized({ users: ['jane@example.com'] }, headersWithEmail())
		);
	});

	it('allows a viewer whose email is in auth.users', async () => {
		await expect(
			assertPageAuthorized(
				{ users: ['jane@example.com'] },
				headersWithEmail('jane@example.com')
			)
		).resolves.toBeUndefined();
	});

	it('is case-insensitive on both sides of the users comparison', async () => {
		await expect(
			assertPageAuthorized(
				{ users: ['Jane@Example.com'] },
				headersWithEmail('jane@example.com')
			)
		).resolves.toBeUndefined();
	});

	it('forbids a viewer whose email is not in auth.users', async () => {
		await expectForbidden(
			assertPageAuthorized(
				{ users: ['jane@example.com'] },
				headersWithEmail('mallory@example.com')
			)
		);
	});

	it('allows a viewer found via auth.query', async () => {
		vi.mocked(runQuery).mockResolvedValue({
			rows: [{ email: 'jane@example.com' }],
			columns: [{ name: 'email', type: 'string' } as never]
		});

		await expect(
			assertPageAuthorized(
				{ query: 'select email from allowed_users' },
				headersWithEmail('jane@example.com')
			)
		).resolves.toBeUndefined();
	});

	it('forbids a viewer not returned by auth.query', async () => {
		vi.mocked(runQuery).mockResolvedValue({
			rows: [{ email: 'jane@example.com' }],
			columns: [{ name: 'email', type: 'string' } as never]
		});

		await expectForbidden(
			assertPageAuthorized(
				{ query: 'select email from allowed_users where page = "other"' },
				headersWithEmail('mallory@example.com')
			)
		);
	});

	it('treats auth.users and auth.query as additive', async () => {
		vi.mocked(runQuery).mockResolvedValue({
			rows: [{ email: 'jane@example.com' }],
			columns: [{ name: 'email', type: 'string' } as never]
		});

		await expect(
			assertPageAuthorized(
				{ users: ['bob@example.com'], query: 'select email from allowed_users' },
				headersWithEmail('jane@example.com')
			)
		).resolves.toBeUndefined();
	});

	it('caches auth.query results across calls with the same query text', async () => {
		vi.mocked(runQuery).mockResolvedValue({
			rows: [{ email: 'jane@example.com' }],
			columns: [{ name: 'email', type: 'string' } as never]
		});
		const query = `select email from allowed_users where page = 'cache-test-${Math.random()}'`;

		await assertPageAuthorized({ query }, headersWithEmail('jane@example.com'));
		await assertPageAuthorized({ query }, headersWithEmail('jane@example.com'));

		expect(runQuery).toHaveBeenCalledOnce();
	});

	it('surfaces a query failure as a 500, not a silent lockout', async () => {
		vi.mocked(runQuery).mockResolvedValue({
			rows: [],
			columns: [],
			error: 'connection refused'
		});

		await expect(
			assertPageAuthorized(
				{ query: `select email from allowed_users where page = 'error-test-${Math.random()}'` },
				headersWithEmail('jane@example.com')
			)
		).rejects.toMatchObject({ status: 500 });
	});
});
