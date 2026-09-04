/**
 * Reads a viewer identity forwarded by a fronting authenticating reverse
 * proxy (oauth2-proxy, Cloudflare Access, etc.) for display in serve mode's
 * sidebar. This is cosmetic only: it does not scope queries, filters, or
 * which reports a viewer can see (self-hosted deployments have no per-viewer
 * access control — see docs/self-host/authentication.mdx).
 *
 * The proxy remains the authentication boundary. Only set
 * EVIDENCE_AUTH_PROXY_EMAIL_HEADER when Evidence is reachable exclusively
 * through that proxy — otherwise a direct request can set the header itself
 * and impersonate any identity in the sidebar.
 */

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
