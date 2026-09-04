/**
 * Enforces a page's `auth:` frontmatter allowlist against the reverse-proxy
 * identity from proxy-auth.server.ts. Self-host only — this is a local
 * extension beyond what's documented upstream (docs/self-host/authentication.mdx
 * states self-hosted deployments have no per-report access control), so it
 * intentionally lives only on this deployment's CLI, not upstream Evidence.
 *
 * `auth.users` and `auth.query` are additive: a viewer is allowed if their
 * email appears in either. Everything no-ops when `auth` is absent, or when
 * there's no proxy identity to check (dev mode always, serve mode when the
 * proxy email header isn't configured) — mirroring how proxy-auth.server.ts
 * itself degrades.
 */

import { error } from '@sveltejs/kit';
import type { AuthConfig } from '@evidence/core/config/auth-frontmatter';
import { runQuery } from './run-query';
import { getProxyUser } from './proxy-auth.server';

const QUERY_CACHE_TTL_MS = 60_000;

interface CachedAllowlist {
	emails: string[];
	expiresAt: number;
}

// Per-process cache keyed by the literal query text — `auth.query` runs
// against a real warehouse on every navigation otherwise, and `runQuery` has
// no result cache of its own.
const queryCache = new Map<string, CachedAllowlist>();

async function resolveQueryEmails(sql: string): Promise<string[]> {
	const cached = queryCache.get(sql);
	if (cached && cached.expiresAt > Date.now()) return cached.emails;

	const result = await runQuery(sql);
	if (result.error) {
		error(500, `auth.query failed: ${result.error}`);
	}

	// Read the first result column as the allowed-emails list, whatever it's named.
	const column = result.columns[0]?.name;
	const emails = column
		? result.rows
				.map((row) => String(row[column] ?? '').trim().toLowerCase())
				.filter(Boolean)
		: [];

	queryCache.set(sql, { emails, expiresAt: Date.now() + QUERY_CACHE_TTL_MS });
	return emails;
}

/**
 * Throws a SvelteKit 403 if `auth` restricts this page and the reverse-proxy
 * viewer isn't allowed. No-op when `auth` is absent/empty. The denial message
 * is `auth.message` when set (with `{email}` substituted), otherwise a
 * generic default — rendered by `routes/+error.svelte`.
 */
export async function assertPageAuthorized(
	auth: AuthConfig | undefined,
	headers: Headers
): Promise<void> {
	if (!auth?.users?.length && !auth?.query) return;

	const proxyUser = getProxyUser(headers);
	if (!proxyUser) {
		error(403, 'This page requires an authenticated viewer identity.');
	}

	const viewerEmail = proxyUser.email.toLowerCase();
	const staticAllowed = (auth.users ?? []).map((email) => email.toLowerCase());
	const queryAllowed = auth.query ? await resolveQueryEmails(auth.query) : [];

	if (!staticAllowed.includes(viewerEmail) && !queryAllowed.includes(viewerEmail)) {
		const message = auth.message
			? auth.message.replaceAll('{email}', proxyUser.email)
			: `${proxyUser.email} does not have access to this page.`;
		error(403, message);
	}
}
