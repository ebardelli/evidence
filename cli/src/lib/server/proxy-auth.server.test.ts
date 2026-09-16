import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';

// jose's Node build fetches a remote JWKS via node:http(s), not global fetch,
// so tests substitute createLocalJWKSet (no network) for createRemoteJWKSet,
// fed whatever key the current test registered via setLatestJwks.
const { setLatestJwks, getLatestJwks } = vi.hoisted(() => {
	let latest: { keys: JWK[] } = { keys: [] };
	return {
		setLatestJwks: (jwks: { keys: JWK[] }) => {
			latest = jwks;
		},
		getLatestJwks: () => latest
	};
});

vi.mock('jose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('jose')>();
	return {
		...actual,
		createRemoteJWKSet: vi.fn(() => actual.createLocalJWKSet(getLatestJwks()))
	};
});

import { getProxyUser, getAccountVariables } from '$lib/server/proxy-auth.server';

const ENV_KEYS = [
	'EVIDENCE_AUTH_PROXY_EMAIL_HEADER',
	'EVIDENCE_AUTH_PROXY_NAME_HEADER',
	'EVIDENCE_AUTH_PROXY_JWT_HEADER',
	'EVIDENCE_AUTH_PROXY_JWT_JWKS_URL',
	'EVIDENCE_AUTH_PROXY_JWT_ISSUER',
	'EVIDENCE_AUTH_PROXY_JWT_AUDIENCE',
	'EVIDENCE_AUTH_PROXY_JWT_EMAIL_CLAIM',
	'EVIDENCE_AUTH_PROXY_JWT_NAME_CLAIM',
	'EVIDENCE_AUTH_DISABLED',
	'EVIDENCE_BASIC_USER',
	'EVIDENCE_BASIC_PASSWORD'
] as const;

function saveEnv() {
	return ENV_KEYS.map((k) => [k, process.env[k]] as const);
}
function restoreEnv(saved: ReturnType<typeof saveEnv>) {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

describe('getProxyUser', () => {
	let saved: ReturnType<typeof saveEnv>;
	beforeEach(() => {
		saved = saveEnv();
		for (const k of ENV_KEYS) delete process.env[k];
	});
	afterEach(() => restoreEnv(saved));

	it('returns null when no email header is configured', async () => {
		const headers = new Headers({ 'X-Auth-Request-Email': 'jane@example.com' });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('returns null when the configured header is absent from the request', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		expect(await getProxyUser(new Headers())).toBeNull();
	});

	it('returns null when the configured header is present but blank', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		const headers = new Headers({ 'X-Auth-Request-Email': '   ' });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('builds a user from the configured email header', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		const headers = new Headers({ 'X-Auth-Request-Email': ' jane@example.com ' });
		expect(await getProxyUser(headers)).toEqual({
			id: 'jane@example.com',
			email: 'jane@example.com',
			firstName: null
		});
	});

	it('reads a custom header name, not just oauth2-proxy defaults', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Custom-User-Email';
		const headers = new Headers({ 'X-Custom-User-Email': 'jane@example.com' });
		expect((await getProxyUser(headers))?.email).toBe('jane@example.com');
	});

	it('includes a display name when the name header is also configured', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER = 'X-Auth-Request-User';
		const headers = new Headers({
			'X-Auth-Request-Email': 'jane@example.com',
			'X-Auth-Request-User': 'Jane Doe'
		});
		expect(await getProxyUser(headers)).toEqual({
			id: 'jane@example.com',
			email: 'jane@example.com',
			firstName: 'Jane Doe'
		});
	});

	it('falls back to a null name when the name header is configured but absent', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER = 'X-Auth-Request-User';
		const headers = new Headers({ 'X-Auth-Request-Email': 'jane@example.com' });
		expect((await getProxyUser(headers))?.firstName).toBeNull();
	});
});

describe('getAccountVariables', () => {
	let saved: ReturnType<typeof saveEnv>;
	beforeEach(() => {
		saved = saveEnv();
		for (const k of ENV_KEYS) delete process.env[k];
	});
	afterEach(() => restoreEnv(saved));

	it('returns undefined when there is no proxy identity', async () => {
		expect(await getAccountVariables(new Headers())).toBeUndefined();
	});

	it('puts the whole display name in first_name, with last_name always null', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER = 'X-Auth-Request-User';
		const headers = new Headers({
			'X-Auth-Request-Email': 'jane@example.com',
			'X-Auth-Request-User': 'Jane Doe'
		});
		expect(await getAccountVariables(headers)).toEqual({
			user: { email: 'jane@example.com', first_name: 'Jane Doe', last_name: null },
			organization: { name: '' }
		});
	});

	it('leaves first_name null when no name header is configured', async () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		const headers = new Headers({ 'X-Auth-Request-Email': 'jane@example.com' });
		expect(await getAccountVariables(headers)).toEqual({
			user: { email: 'jane@example.com', first_name: null, last_name: null },
			organization: { name: '' }
		});
	});
});

describe('getProxyUser (JWT mode)', () => {
	let saved: ReturnType<typeof saveEnv>;
	let testCounter = 0;

	beforeEach(() => {
		saved = saveEnv();
		for (const k of ENV_KEYS) delete process.env[k];
		testCounter += 1;
	});
	afterEach(() => restoreEnv(saved));

	// Each test gets its own JWKS URL so the module-level remote-JWKS cache in
	// proxy-auth.server.ts never serves a previous test's keys.
	function jwksUrl() {
		return `https://idp.example.test/jwks-${testCounter}.json`;
	}

	async function issueKeyPair() {
		const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
		const jwk = await exportJWK(publicKey);
		jwk.kid = `test-key-${testCounter}`;
		jwk.alg = 'RS256';
		jwk.use = 'sig';
		return { privateKey, jwk };
	}

	function stubJwks(jwk: Awaited<ReturnType<typeof issueKeyPair>>['jwk']) {
		setLatestJwks({ keys: [jwk] });
	}

	async function sign(
		privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'],
		kid: string,
		claims: Record<string, unknown>,
		opts: { issuer?: string; audience?: string; expiresInSeconds?: number; subject?: string } = {}
	) {
		let builder = new SignJWT(claims)
			.setProtectedHeader({ alg: 'RS256', kid })
			.setIssuedAt()
			.setExpirationTime(
				Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 300)
			);
		if (opts.issuer) builder = builder.setIssuer(opts.issuer);
		if (opts.audience) builder = builder.setAudience(opts.audience);
		if (opts.subject) builder = builder.setSubject(opts.subject);
		return builder.sign(privateKey);
	}

	it('verifies a Bearer JWT in the Authorization header by default', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_ISSUER = 'https://idp.example.test';
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com', name: 'Jane Doe' },
			{ issuer: 'https://idp.example.test', audience: 'evidence', subject: 'user-123' }
		);

		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect(await getProxyUser(headers)).toEqual({
			id: 'user-123',
			email: 'jane@example.com',
			firstName: 'Jane Doe'
		});
	});

	it('never trusts the plain email header once JWT mode is configured, even without a token', async () => {
		const url = jwksUrl();
		const { jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		// An attacker-controlled header, present alongside JWT-mode config.
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Email';

		const headers = new Headers({ 'X-Auth-Email': 'admin@example.com' });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('rejects a token signed by an untrusted key', async () => {
		const url = jwksUrl();
		const { jwk } = await issueKeyPair();
		const { privateKey: forgedKey } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const forgedToken = await sign(forgedKey, jwk.kid as string, {
			email: 'attacker@example.com'
		});
		const headers = new Headers({ Authorization: `Bearer ${forgedToken}` });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('rejects an expired token', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ expiresInSeconds: -60, audience: 'evidence' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });

		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await getProxyUser(headers)).toBeNull();
		// The routine case (a viewer's token simply aged out) is logged
		// quietly rather than at warn level, unlike a genuinely bad token.
		expect(debugSpy).toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		debugSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it('rejects a token with the wrong issuer', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_ISSUER = 'https://idp.example.test';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ issuer: 'https://evil.example.test' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('rejects a token with the wrong audience', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ audience: 'some-other-app' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('returns null when no token is present on the configured header', async () => {
		const url = jwksUrl();
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		expect(await getProxyUser(new Headers())).toBeNull();
	});

	it('reads the token from a custom header without a Bearer prefix (e.g. IAP-style headers)', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		process.env.EVIDENCE_AUTH_PROXY_JWT_HEADER = 'X-Goog-IAP-JWT-Assertion';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ 'X-Goog-IAP-JWT-Assertion': token });
		expect((await getProxyUser(headers))?.email).toBe('jane@example.com');
	});

	it('accepts a lowercase "bearer" prefix, not just "Bearer"', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ Authorization: `bearer ${token}` });
		expect((await getProxyUser(headers))?.email).toBe('jane@example.com');
	});

	it('reads email/name from custom claim names when configured', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		process.env.EVIDENCE_AUTH_PROXY_JWT_EMAIL_CLAIM = 'upn';
		process.env.EVIDENCE_AUTH_PROXY_JWT_NAME_CLAIM = 'preferred_username';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ upn: 'jane@example.com', preferred_username: 'jdoe' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect(await getProxyUser(headers)).toEqual({
			id: 'jane@example.com',
			email: 'jane@example.com',
			firstName: 'jdoe'
		});
	});

	it('falls back to the email as id when the token has no sub claim', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect((await getProxyUser(headers))?.id).toBe('jane@example.com');
	});

	it('returns null when the verified token has no email claim', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ name: 'Jane Doe' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect(await getProxyUser(headers)).toBeNull();
	});

	it('flows through getAccountVariables too', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com', name: 'Jane Doe' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ Authorization: `Bearer ${token}` });
		expect(await getAccountVariables(headers)).toEqual({
			user: { email: 'jane@example.com', first_name: 'Jane Doe', last_name: null },
			organization: { name: '' }
		});
	});

	it('rejects JWT mode configured without an issuer or audience', async () => {
		const url = jwksUrl();
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		// Neither ISSUER nor AUDIENCE set — any validly-signed token from this
		// JWKS would otherwise be accepted, including one minted for an
		// unrelated application on the same identity provider.
		await expect(getProxyUser(new Headers())).rejects.toThrow(/ISSUER.*AUDIENCE|AUDIENCE.*ISSUER/);
	});

	it('rejects a non-https JWKS URL', async () => {
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = 'http://idp.example.test/jwks.json';
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		await expect(getProxyUser(new Headers())).rejects.toThrow(/https/);
	});

	it('rejects JWT mode reading the default Authorization header while HTTP Basic Auth is configured', async () => {
		const url = jwksUrl();
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		process.env.EVIDENCE_BASIC_USER = 'admin';
		process.env.EVIDENCE_BASIC_PASSWORD = 'secret';

		await expect(getProxyUser(new Headers())).rejects.toThrow(/Basic Auth/);
	});

	it('allows JWT mode + Basic Auth together once the JWT header is moved off Authorization', async () => {
		const url = jwksUrl();
		const { privateKey, jwk } = await issueKeyPair();
		stubJwks(jwk);
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		process.env.EVIDENCE_AUTH_PROXY_JWT_HEADER = 'X-Forwarded-Access-Token';
		process.env.EVIDENCE_BASIC_USER = 'admin';
		process.env.EVIDENCE_BASIC_PASSWORD = 'secret';

		const token = await sign(
			privateKey,
			jwk.kid as string,
			{ email: 'jane@example.com' },
			{ audience: 'evidence' }
		);
		const headers = new Headers({ 'X-Forwarded-Access-Token': token });
		expect((await getProxyUser(headers))?.email).toBe('jane@example.com');
	});

	it('allows JWT mode + Basic Auth together when auth is explicitly disabled', async () => {
		const url = jwksUrl();
		process.env.EVIDENCE_AUTH_PROXY_JWT_JWKS_URL = url;
		process.env.EVIDENCE_AUTH_PROXY_JWT_AUDIENCE = 'evidence';
		process.env.EVIDENCE_BASIC_USER = 'admin';
		process.env.EVIDENCE_BASIC_PASSWORD = 'secret';
		process.env.EVIDENCE_AUTH_DISABLED = 'true';

		expect(await getProxyUser(new Headers())).toBeNull();
	});
});
