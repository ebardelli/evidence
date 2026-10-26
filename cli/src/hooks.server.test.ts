import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pagesWithAuth } from '$lib/server/query-authz.server';

vi.mock('$lib/server/query-authz.server', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/query-authz.server')>()),
	pagesWithAuth: vi.fn()
}));
vi.mock('$cli/connection', () => ({ loadConnectionConfig: async () => null }));

import { handle, init } from './hooks.server';

const ENV_KEYS = [
	'EVIDENCE_SERVE',
	'EVIDENCE_QUERY_AUTHZ',
	'EVIDENCE_AUTH_PROXY_JWT_JWKS_URL',
	'EVIDENCE_AUTH_PROXY_EMAIL_HEADER',
	'EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER',
	'EVIDENCE_BASIC_USER',
	'EVIDENCE_BASIC_PASSWORD'
];
let saved: [string, string | undefined][];
beforeEach(() => {
	saved = ENV_KEYS.map((k) => [k, process.env[k]]);
	for (const k of ENV_KEYS) delete process.env[k];
	vi.mocked(pagesWithAuth).mockReset().mockResolvedValue([]);
});
afterEach(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

async function request(pathname: string): Promise<number> {
	const resolve = vi.fn(async () => new Response('ok'));
	const event = { url: new URL(`http://localhost${pathname}`), request: new Request(`http://localhost${pathname}`, { method: 'POST' }) };
	const response = await handle({ event, resolve } as never);
	return response.status;
}

describe('serve-mode disabled routes', () => {
	it.each(['/api/validate', '/api/docs/list', '/api/docs/read/x'])('404s %s in serve mode', async (p) => {
		process.env.EVIDENCE_SERVE = '1';
		expect(await request(p)).toBe(404);
	});

	it('leaves them alone in dev mode', async () => {
		expect(await request('/api/validate')).toBe(200);
	});
});

describe('init', () => {
	it('does nothing outside serve mode', async () => {
		vi.mocked(pagesWithAuth).mockResolvedValue(['secret']);
		await expect(init()).resolves.toBeUndefined();
	});

	it('refuses to start with auth: pages and no proxy identity configured', async () => {
		process.env.EVIDENCE_SERVE = '1';
		vi.mocked(pagesWithAuth).mockResolvedValue(['discipline/incidents']);
		await expect(init()).rejects.toThrow(/discipline\/incidents/);
	});

	it('refuses plain-header identity without the trust opt-in', async () => {
		process.env.EVIDENCE_SERVE = '1';
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		await expect(init()).rejects.toThrow(/EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER/);
		process.env.EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER = 'true';
		await expect(init()).resolves.toBeUndefined();
	});

	it('starts with JWT identity and auth: pages', async () => {
		process.env.EVIDENCE_SERVE = '1';
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = 'https://idp.example.com/jwks';
		vi.mocked(pagesWithAuth).mockResolvedValue(['secret']);
		await expect(init()).resolves.toBeUndefined();
	});
});
