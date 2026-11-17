/**
 * Query proxy endpoint.
 *
 * Thin HTTP wrapper around `runQuery` (see `$lib/server/run-query`), which holds
 * the shared logic: run against connection.yaml if present, else proxy to the
 * managed Evidence query engine.
 *
 * In serve mode, `authorizeQuery` applies the project's `auth.rows` row
 * filters (see row-security.server.ts): the request names the page it comes
 * from, and the SQL that runs is rewritten so filtered tables are read only
 * through that page's filters. Dev mode runs the SQL as sent.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runQuery } from '$lib/server/run-query';
import { isServeMode } from '$lib/server/serve-mode';
import { authorizeQuery } from '$lib/server/row-security.server';

// Failures go out as `{ error }` (what CLIQueryService reads), never via
// SvelteKit's error(), whose `{ message }` body the client would ignore.
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	let sql = body?.sql;

	if (!sql || typeof sql !== 'string') {
		return json({ error: 'Missing sql parameter' }, { status: 400 });
	}

	if (isServeMode()) {
		const authz = await authorizeQuery(body?.page, sql, request.headers);
		if (!authz.ok) return json({ error: authz.error }, { status: authz.status });
		sql = authz.sql;
	}

	const result = await runQuery(sql);

	if (result.error) {
		return json({ error: result.error }, { status: result.status ?? 500 });
	}

	return json({ rows: result.rows, columns: result.columns, source: result.source });
};
