/**
 * Query proxy endpoint.
 *
 * Thin HTTP wrapper around `runQuery` (see `$lib/server/run-query`), which holds
 * the shared logic: run against connection.yaml if present, else proxy to the
 * managed Evidence query engine.
 *
 * In serve mode the request must also name the page it comes from, and
 * `authorizeQuery` checks the viewer against that page's `auth:` and the
 * tables its queries read (see query-authz.server.ts). Dev mode — and serve
 * mode with EVIDENCE_QUERY_AUTHZ=off — runs the SQL as sent.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runQuery } from '$lib/server/run-query';
import { authorizeQuery, queryAuthzEnabled } from '$lib/server/query-authz.server';

// Failures go out as `{ error }` (what CLIQueryService reads), never via
// SvelteKit's error(), whose `{ message }` body the client would ignore.
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const sql = body?.sql;
	const page = body?.page;

	if (!sql || typeof sql !== 'string') {
		return json({ error: 'Missing sql parameter' }, { status: 400 });
	}

	if (queryAuthzEnabled()) {
		if (typeof page !== 'string') {
			return json({ error: 'Missing page parameter' }, { status: 400 });
		}
		const authz = await authorizeQuery(page, sql, request.headers);
		if (!authz.ok) return json({ error: authz.error }, { status: authz.status });
	}

	const result = await runQuery(sql);

	if (result.error) {
		return json({ error: result.error }, { status: result.status ?? 500 });
	}

	return json({ rows: result.rows, columns: result.columns, source: result.source });
};
