/**
 * Reads a viewer identity forwarded by a fronting authenticating reverse
 * proxy (oauth2-proxy, Cloudflare Access, etc.) for display in serve mode's
 * sidebar, and for the `{{ $user.* }}` variables markdown/SQL can reference
 * (see getAccountVariables below). This is cosmetic/convenience only: it
 * does not scope queries, filters, or which reports a viewer can see
 * (self-hosted deployments have no per-viewer access control — see
 * docs/self-host/authentication.mdx).
 *
 * The proxy remains the authentication boundary. Only set
 * EVIDENCE_AUTH_PROXY_EMAIL_HEADER when Evidence is reachable exclusively
 * through that proxy — otherwise a direct request can set the header itself
 * and impersonate any identity in the sidebar or in `{{ $user.* }}`.
 */

import type { AccountVariables } from '@evidence/core/types/account-variables';

export interface ProxyUser {
	id: string;
	email: string;
	firstName?: string | null;
}

export function getProxyUser(headers: Headers): ProxyUser | null {
	const emailHeader = process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER;
	if (!emailHeader) return null;

	const email = headers.get(emailHeader)?.trim();
	if (!email) return null;

	const nameHeader = process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER;
	const firstName = (nameHeader && headers.get(nameHeader)?.trim()) || null;

	return { id: email, email, firstName };
}

/**
 * Builds the `{{ $user.* }}` variables core's markdown/SQL interpolation
 * resolves (core/src/types/account-variables.ts), sourced from the same
 * proxy-forwarded identity as getProxyUser. oauth2-proxy and friends forward
 * a single display name header, not separate first/last names, so the whole
 * value goes in `first_name` and `last_name` is always null.
 *
 * `organization.name` has no self-host equivalent (no org concept from a
 * reverse proxy) and is left an empty string — `{{ $organization.name }}`
 * simply renders blank rather than erroring.
 */
export function getAccountVariables(headers: Headers): AccountVariables | undefined {
	const proxyUser = getProxyUser(headers);
	if (!proxyUser) return undefined;

	return {
		user: {
			email: proxyUser.email,
			first_name: proxyUser.firstName ?? null,
			last_name: null
		},
		organization: { name: '' }
	};
}
