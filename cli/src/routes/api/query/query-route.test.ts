import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runQuery } from '$lib/server/run-query';
import { authorizeQuery } from '$lib/server/row-security.server';

vi.mock('$lib/server/run-query', () => ({ runQuery: vi.fn() }));
vi.mock('$lib/server/row-security.server', () => ({ authorizeQuery: vi.fn() }));

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

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.EVIDENCE_SERVE;
	delete process.env.EVIDENCE_SERVE;
	vi.mocked(runQuery).mockReset().mockResolvedValue({ rows: [{ a: 1 }], columns: [] });
	vi.mocked(authorizeQuery)
		.mockReset()
		.mockImplementation(async (_page, sql) => ({ ok: true, sql }));
});
afterEach(() => {
	if (saved === undefined) delete process.env.EVIDENCE_SERVE;
	else process.env.EVIDENCE_SERVE = saved;
});

describe('POST /api/query', () => {
	it('runs raw SQL in dev mode without authorization', async () => {
		const res = await post({ sql: 'select 1' });
		expect(res.status).toBe(200);
		expect(authorizeQuery).not.toHaveBeenCalled();
		expect(runQuery).toHaveBeenCalledWith('select 1');
	});

	it('returns the authorization failure as { error } with its status', async () => {
		process.env.EVIDENCE_SERVE = '1';
		vi.mocked(authorizeQuery).mockResolvedValue({ ok: false, status: 403, error: 'nope' });
		const res = await post({ sql: 'select 1', page: 'secret' });
		expect(res).toEqual({ status: 403, body: { error: 'nope' } });
		expect(authorizeQuery).toHaveBeenCalledWith('secret', 'select 1', expect.any(Headers));
		expect(runQuery).not.toHaveBeenCalled();
	});

	it('runs the SQL authorizeQuery returns', async () => {
		process.env.EVIDENCE_SERVE = '1';
		vi.mocked(authorizeQuery).mockResolvedValue({ ok: true, sql: 'select filtered' });
		const res = await post({ sql: 'select 1', page: '' });
		expect(res.status).toBe(200);
		expect(runQuery).toHaveBeenCalledWith('select filtered');
	});

	it('rejects a missing sql field', async () => {
		expect((await post({ page: '' })).status).toBe(400);
	});
});
