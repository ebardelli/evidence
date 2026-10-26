import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runQuery } from '$lib/server/run-query';
import { authorizeQuery } from '$lib/server/query-authz.server';

vi.mock('$lib/server/run-query', () => ({ runQuery: vi.fn() }));
vi.mock('$lib/server/query-authz.server', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/query-authz.server')>()),
	authorizeQuery: vi.fn()
}));

import { POST } from './+server';

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const request = new Request('http://localhost/api/query', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const response = await POST({ request } as never);
	return { status: response.status, body: await response.json() };
}

let saved: [string, string | undefined][];
beforeEach(() => {
	saved = ['EVIDENCE_SERVE', 'EVIDENCE_QUERY_AUTHZ'].map((k) => [k, process.env[k]]);
	delete process.env.EVIDENCE_SERVE;
	delete process.env.EVIDENCE_QUERY_AUTHZ;
	vi.mocked(runQuery).mockReset().mockResolvedValue({ rows: [{ a: 1 }], columns: [] });
	vi.mocked(authorizeQuery).mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe('POST /api/query', () => {
	it('runs raw SQL in dev mode without authorization', async () => {
		const res = await post({ sql: 'select 1' });
		expect(res.status).toBe(200);
		expect(authorizeQuery).not.toHaveBeenCalled();
		expect(runQuery).toHaveBeenCalledWith('select 1');
	});

	it('requires a page in serve mode', async () => {
		process.env.EVIDENCE_SERVE = '1';
		const res = await post({ sql: 'select 1' });
		expect(res).toEqual({ status: 400, body: { error: 'Missing page parameter' } });
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('returns the authorization failure as { error } with its status', async () => {
		process.env.EVIDENCE_SERVE = '1';
		vi.mocked(authorizeQuery).mockResolvedValue({ ok: false, status: 403, error: 'nope' });
		const res = await post({ sql: 'select 1', page: 'secret' });
		expect(res).toEqual({ status: 403, body: { error: 'nope' } });
		expect(authorizeQuery).toHaveBeenCalledWith('secret', 'select 1', expect.any(Headers));
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('runs the query once authorized', async () => {
		process.env.EVIDENCE_SERVE = '1';
		const res = await post({ sql: 'select 1', page: '' });
		expect(res.status).toBe(200);
		expect(runQuery).toHaveBeenCalledWith('select 1');
	});

	it('skips authorization with EVIDENCE_QUERY_AUTHZ=off', async () => {
		process.env.EVIDENCE_SERVE = '1';
		process.env.EVIDENCE_QUERY_AUTHZ = 'off';
		const res = await post({ sql: 'select 1' });
		expect(res.status).toBe(200);
		expect(authorizeQuery).not.toHaveBeenCalled();
	});

	it('rejects a missing sql field', async () => {
		expect((await post({ page: '' })).status).toBe(400);
	});
});
