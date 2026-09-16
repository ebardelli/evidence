/**
 * Reads a viewer identity forwarded by a fronting authenticating reverse
 * proxy (oauth2-proxy, Cloudflare Access, GCP IAP, Pomerium, etc.) for
 * display in serve mode's sidebar, and for the `{{ $user.* }}` variables
 * markdown/SQL can reference (see getAccountVariables below). This is
 * cosmetic/convenience only: it does not scope queries, filters, or which
 * reports a viewer can see beyond the `auth:` frontmatter allowlist in
 * page-auth.server.ts (self-hosted deployments have no other per-viewer
 * access control — see docs/self-host/authentication.mdx).
 *
 * Two trust modes, selected by which env vars are set:
 *
 * - JWT mode (EVIDENCE_AUTH_PROXY_JWT_JWKS_URL set, which must be https://):
 *   the identity comes only from a JWT whose signature is verified against
 *   the configured JWKS, and whose `exp` plus at least one of `iss`/`aud` are
 *   checked (one of EVIDENCE_AUTH_PROXY_JWT_ISSUER/_AUDIENCE is required —
 *   otherwise any validly-signed token from that JWKS, including one minted
 *   for an unrelated application on the same identity provider, would pass).
 *   This is safe even if a request can reach Evidence directly, bypassing
 *   the proxy — a forged header alone can't produce a validly signed token.
 *   Most identity-aware proxies forward such a token: oauth2-proxy
 *   (`--pass-authorization-header`), Cloudflare Access
 *   (`Cf-Access-Jwt-Assertion`), GCP IAP (`X-Goog-IAP-JWT-Assertion`),
 *   Pomerium (`X-Pomerium-Jwt-Assertion`). EVIDENCE_AUTH_PROXY_JWT_HEADER
 *   defaults to `Authorization`, which can't be combined with HTTP Basic
 *   Auth (EVIDENCE_BASIC_USER/PASSWORD) — Basic Auth's gate runs first and
 *   would reject every bearer token before JWT verification ever ran, so
 *   that combination is rejected at startup.
 * - Plain header mode (EVIDENCE_AUTH_PROXY_EMAIL_HEADER set, JWT mode unset):
 *   the identity is whatever value is sitting in the configured header, with
 *   no verification at all. Only safe when Evidence is reachable exclusively
 *   through the proxy — otherwise a direct request can set the header itself
 *   and impersonate any identity. Kept for proxies that don't forward a
 *   verifiable token (e.g. Authelia/Authentik's plain Remote-Email header).
 *
 * JWT mode takes precedence when both are configured, and plain header
 * values are never consulted in that case.
 *
 * Either mode can end up with no identity on a given request even though
 * it's configured — a missing/expired JWT, or a blank header from a proxy
 * whose own session lapsed. EVIDENCE_AUTH_PROXY_LOGIN_URL (see
 * getProxyLoginUrl) sends the viewer through the proxy's sign-in flow
 * instead of quietly falling back to serve mode's "not logged in" sidebar
 * state; EVIDENCE_AUTH_PROXY_LOGOUT_URL (see getProxyLogoutUrl) points the
 * sidebar's "Log out" action at the proxy's sign-out endpoint. Both are
 * unset by default.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import type { AccountVariables } from '@evidence/core/types/account-variables';
import { authDisabled } from '$cli/basic-auth';
import { basicAuthConfigured } from './serve-mode';

export interface ProxyUser {
	id: string;
	email: string;
	firstName?: string | null;
	profilePictureUrl?: string | null;
}

// Only asymmetric algorithms an identity provider would plausibly sign an ID
// token/access token with. Passed explicitly to jwtVerify as defense in
// depth against algorithm-confusion attacks, on top of jose's own JWKS
// key-type matching (a JWKS of public keys can't satisfy an HS* signature).
const ALLOWED_JWT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];

// Keyed by JWKS URL so a changed env var (or a differently-configured test)
// gets a fresh set; jose's createRemoteJWKSet already caches individual keys
// internally and re-fetches on a signing-key miss, so reuse the same
// instance across requests rather than re-creating it per call.
let jwksCache: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(url: string) {
	if (jwksCache?.url !== url) {
		jwksCache = { url, jwks: createRemoteJWKSet(new URL(url)) };
	}
	return jwksCache.jwks;
}

// Config errors (bad JWKS scheme, missing audience/issuer, header collision
// with Basic Auth) are checked on every call rather than memoized — cheap
// string/env checks, and env vars can legitimately differ between requests
// in tests. Called before the jwtVerify try/catch below so a config error
// surfaces as a loud 500, not a silently-swallowed "rejected token".
function assertJwtConfigValid(headerName: string, jwksUrl: string): void {
	const parsed = new URL(jwksUrl);
	// A misconfigured http:// JWKS endpoint would let a network attacker
	// substitute their own signing keys, defeating the entire point of
	// verifying a signature. localhost is exempted for local testing against
	// a proxy/IdP running on the same machine.
	if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
		throw new Error(
			`EVIDENCE_AUTH_PROXY_JWT_JWKS_URL must use https:// (got "${parsed.protocol}"). ` +
				'A non-TLS JWKS endpoint lets a network attacker substitute their own signing keys.'
		);
	}

	if (!process.env.EVIDENCE_AUTH_PROXY_JWT_ISSUER && !process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE) {
		throw new Error(
			'EVIDENCE_AUTH_PROXY_JWT_JWKS_URL is set but neither EVIDENCE_AUTH_PROXY_JWT_ISSUER nor ' +
				'EVIDENCE_AUTH_PROXY_JWT_AUDIENCE is configured. Without at least one, any validly-signed ' +
				"token from this JWKS endpoint is accepted — including one minted for a completely " +
				'different application that happens to share the same identity provider. Set at least one ' +
				'(both is best).'
		);
	}

	if (headerName.toLowerCase() === 'authorization' && basicAuthConfigured() && !authDisabled()) {
		throw new Error(
			'EVIDENCE_AUTH_PROXY_JWT_JWKS_URL and HTTP Basic Auth (EVIDENCE_BASIC_USER/EVIDENCE_BASIC_PASSWORD) ' +
				"are both configured, and JWT verification is reading the same Authorization header Basic " +
				"Auth uses. Basic Auth's gate runs first and will reject every Bearer token with 401 before " +
				'JWT verification ever runs. Set EVIDENCE_AUTH_PROXY_JWT_HEADER to a dedicated header (e.g. ' +
				'X-Forwarded-Access-Token) and configure the proxy to forward the token there.'
		);
	}
}

function claimString(payload: JWTPayload, claim: string): string | null {
	const value = payload[claim];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// EVIDENCE_AUTH_PROXY_JWT_ISSUER/_AUDIENCE accept a comma-separated list of
// acceptable values, not just one — some identity providers legitimately
// issue tokens with more than one valid value for the same claim. Google is
// the standing example: its own verification libraries accept both
// "accounts.google.com" and "https://accounts.google.com" as `iss` (see
// google-auth-library's default `issuers`), and which form a given token
// actually carries isn't something a deployment controls.
function parseMultiValueClaim(envValue: string | undefined): string[] | undefined {
	const values = (envValue ?? '')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
	return values.length ? values : undefined;
}

async function getJwtVerifiedUser(headers: Headers, jwksUrl: string): Promise<ProxyUser | null> {
	const headerName = process.env.EVIDENCE_AUTH_PROXY_JWT_HEADER || 'Authorization';
	assertJwtConfigValid(headerName, jwksUrl);

	const raw = headers.get(headerName)?.trim();
	if (!raw) return null;

	const token = /^bearer /i.test(raw) ? raw.slice('bearer '.length).trim() : raw;
	if (!token) return null;

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, getJwks(jwksUrl), {
			algorithms: ALLOWED_JWT_ALGORITHMS,
			issuer: parseMultiValueClaim(process.env.EVIDENCE_AUTH_PROXY_JWT_ISSUER),
			audience: parseMultiValueClaim(process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE)
		}));
	} catch (err) {
		// A present-but-invalid token (bad signature, expired, wrong
		// issuer/audience) is treated the same as no identity at all — never
		// fall back to trusting an unverified header in this mode. Expired
		// tokens are the routine case (a viewer's session token simply aged
		// out) so they're logged at debug level; anything else is more
		// likely a real misconfiguration or attack and is worth surfacing.
		const isExpired = err instanceof joseErrors.JWTExpired;
		let message = err instanceof Error ? err.message : 'verification failed';
		// jose validates the signature before checking claims, so on a claim
		// mismatch `err.payload` is already-verified — safe to log the actual
		// value alongside what was configured, which is most of the work of
		// diagnosing a misconfigured issuer/audience.
		if (err instanceof joseErrors.JWTClaimValidationFailed && (err.claim === 'iss' || err.claim === 'aud')) {
			const expected =
				err.claim === 'iss'
					? process.env.EVIDENCE_AUTH_PROXY_JWT_ISSUER
					: process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE;
			message += ` (token's "${err.claim}" is ${JSON.stringify(err.payload[err.claim])}, configured value is ${JSON.stringify(expected)})`;
		}
		if (isExpired) {
			console.debug(`Rejected reverse-proxy JWT: ${message}`);
		} else {
			console.warn(`Rejected reverse-proxy JWT: ${message}`);
		}
		return null;
	}

	const emailClaim = process.env.EVIDENCE_AUTH_PROXY_JWT_EMAIL_CLAIM || 'email';
	const email = claimString(payload, emailClaim);
	if (!email) return null;

	const nameClaim = process.env.EVIDENCE_AUTH_PROXY_JWT_NAME_CLAIM || 'name';
	const firstName = claimString(payload, nameClaim);
	const id = (typeof payload.sub === 'string' && payload.sub) || email;

	return { id, email, firstName };
}

function getHeaderTrustedUser(headers: Headers): ProxyUser | null {
	const emailHeader = process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER;
	if (!emailHeader) return null;

	const email = headers.get(emailHeader)?.trim();
	if (!email) return null;

	const nameHeader = process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER;
	const firstName = (nameHeader && headers.get(nameHeader)?.trim()) || null;

	return { id: email, email, firstName };
}

export async function getProxyUser(headers: Headers): Promise<ProxyUser | null> {
	const jwksUrl = process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL;
	if (jwksUrl) return getJwtVerifiedUser(headers, jwksUrl);
	return getHeaderTrustedUser(headers);
}

// True once either trust mode above is set up, so callers can tell "no
// proxy identity because nothing is configured" (expected, e.g. dev mode or
// a deployment not using this feature) apart from "no proxy identity despite
// JWT/header mode being configured" (the proxy's session lapsed, or its
// forwarded token expired/rotated) — only the latter should ever trigger a
// login redirect.
export function proxyAuthConfigured(): boolean {
	return !!(process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL || process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER);
}

// Where to send a viewer whose proxy identity is missing or failed
// verification — typically the proxy's own sign-in endpoint (e.g.
// oauth2-proxy's `/oauth2/start`), which re-runs the IdP flow and hands
// Evidence a fresh token on the way back. Unset by default: a lapsed
// identity degrades to the existing "not logged in" sidebar state rather
// than forcing a redirect.
export function getProxyLoginUrl(): string | null {
	return process.env.EVIDENCE_AUTH_PROXY_LOGIN_URL?.trim() || null;
}

// Where the sidebar's "Log out" action should send a viewer with a proxy
// identity — typically the proxy's own sign-out endpoint (e.g. oauth2-proxy's
// `/oauth2/sign_out`), which clears its session so the next request re-runs
// the IdP flow. Unset by default: no logout action is shown.
export function getProxyLogoutUrl(): string | null {
	return process.env.EVIDENCE_AUTH_PROXY_LOGOUT_URL?.trim() || null;
}

/**
 * Builds the `{{ $user.* }}` variables core's markdown/SQL interpolation
 * resolves (core/src/types/account-variables.ts), sourced from the same
 * proxy-forwarded identity as getProxyUser. Most proxies (and JWT ID token
 * claims) forward a single display name, not separate first/last names, so
 * the whole value goes in `first_name` and `last_name` is always null.
 *
 * `organization.name` has no self-host equivalent (no org concept from a
 * reverse proxy) and is left an empty string — `{{ $organization.name }}`
 * simply renders blank rather than erroring.
 */
export async function getAccountVariables(headers: Headers): Promise<AccountVariables | undefined> {
	const proxyUser = await getProxyUser(headers);
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
