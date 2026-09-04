import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProxyUser } from '$lib/server/proxy-auth.server';

const ENV_KEYS = ['EVIDENCE_AUTH_PROXY_EMAIL_HEADER', 'EVIDENCE_AUTH_PROXY_NAME_HEADER'] as const;

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

	it('returns null when no email header is configured', () => {
		const headers = new Headers({ 'X-Auth-Request-Email': 'jane@example.com' });
		expect(getProxyUser(headers)).toBeNull();
	});

	it('returns null when the configured header is absent from the request', () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		expect(getProxyUser(new Headers())).toBeNull();
	});

	it('returns null when the configured header is present but blank', () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		const headers = new Headers({ 'X-Auth-Request-Email': '   ' });
		expect(getProxyUser(headers)).toBeNull();
	});

	it('builds a user from the configured email header', () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		const headers = new Headers({ 'X-Auth-Request-Email': ' jane@example.com ' });
		expect(getProxyUser(headers)).toEqual({
			id: 'jane@example.com',
			email: 'jane@example.com',
			firstName: null
		});
	});

	it('reads a custom header name, not just oauth2-proxy defaults', () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Custom-User-Email';
		const headers = new Headers({ 'X-Custom-User-Email': 'jane@example.com' });
		expect(getProxyUser(headers)?.email).toBe('jane@example.com');
	});

	it('includes a display name when the name header is also configured', () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER = 'X-Auth-Request-User';
		const headers = new Headers({
			'X-Auth-Request-Email': 'jane@example.com',
			'X-Auth-Request-User': 'Jane Doe'
		});
		expect(getProxyUser(headers)).toEqual({
			id: 'jane@example.com',
			email: 'jane@example.com',
			firstName: 'Jane Doe'
		});
	});

	it('falls back to a null name when the name header is configured but absent', () => {
		process.env.EVIDENCE_AUTH_PROXY_EMAIL_HEADER = 'X-Auth-Request-Email';
		process.env.EVIDENCE_AUTH_PROXY_NAME_HEADER = 'X-Auth-Request-User';
		const headers = new Headers({ 'X-Auth-Request-Email': 'jane@example.com' });
		expect(getProxyUser(headers)?.firstName).toBeNull();
	});
});
