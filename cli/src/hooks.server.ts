import type { Handle, ServerInit } from '@sveltejs/kit';
import { proxyAuthConfigured } from '$lib/server/proxy-auth.server';
import {
	identityMode,
	pagesWithLegacyAuth,
	pagesWithRowFilters,
	plainHeaderTrusted
} from '$lib/server/row-security.server';
import { supportsRowFilters } from '$lib/server/row-filter-sql';
import { loadConnectionConfig } from '$cli/connection';
import { stat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isServeMode, basicAuthConfigured } from '$lib/server/serve-mode';
import { checkBasicAuth, SERVE_HARDENED_HEADERS } from '$cli/basic-auth';
import { getProjectCwd } from '$lib/server/project-cwd';

const STATIC_CONTENT_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.pdf': 'application/pdf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.txt': 'text/plain'
};

/**
 * Serve the project's static/ directory (the legacy Evidence convention for images and
 * other assets referenced as absolute paths, e.g. /img/logo.png). Only known
 * asset extensions are considered so page routes are never shadowed.
 */
async function serveProjectStatic(pathname: string): Promise<Response | null> {
	const ext = path.extname(pathname).toLowerCase();
	const contentType = STATIC_CONTENT_TYPES[ext];
	if (!contentType) return null;

	const staticDir = path.join(getProjectCwd(), 'static');
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// Malformed percent-encoding: not a static asset, fall through to routing.
		return null;
	}
	// Resolve and confine to the static dir. Containment is checked on the
	// real (symlink-resolved) path — a link inside static/ pointing elsewhere
	// must not serve files from outside the project.
	const resolved = path.resolve(path.join(staticDir, decoded));
	if (!resolved.startsWith(path.resolve(staticDir) + path.sep)) return null;

	try {
		const real = await realpath(resolved);
		if (!real.startsWith((await realpath(staticDir)) + path.sep)) return null;
		const stats = await stat(real);
		if (!stats.isFile()) return null;
		const body = await readFile(real);
		return new Response(new Uint8Array(body), {
			headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' }
		});
	} catch {
		return null;
	}
}

// Routes that only exist for Studio auth, dev reload or authoring tools —
// none belong in serve mode (serve requires connection.yaml and ships
// immutable content). /api/validate runs metadata queries and returns project
// source with no page check; `evidence validate` calls it in-process instead.
const SERVE_DISABLED_PATHS = [
	'/login',
	'/api/auth/status',
	'/api/logout',
	'/api/switch-org',
	'/api/project-changed',
	'/api/validate',
	'/api/docs'
];

// Serve-mode startup checks — throwing here stops `evidence serve` before it
// binds a port (cli/cli/server.ts awaits server.init()). Row filters fail
// closed: without a verified identity or a DuckDB-flavoured connection to
// rewrite queries on, `auth.rows` pages would otherwise serve unfiltered data.
export const init: ServerInit = async () => {
	if (!isServeMode()) return;

	const legacy = await pagesWithLegacyAuth();
	if (legacy.length > 0) {
		throw new Error(
			`\`auth.users\` and \`auth.query\` were replaced by \`auth.rows\` row filters; ` +
				`these pages would be served unrestricted: ${legacy.join(', ')}`
		);
	}

	const pages = (await pagesWithRowFilters()).map((p) => p.slug);
	if (pages.length === 0) return;

	if (!proxyAuthConfigured()) {
		throw new Error(
			`These pages have \`auth.rows\` filters, but no reverse-proxy identity is configured ` +
				`(EVIDENCE_AUTH_PROXY_JWT_JWKS_URL or EVIDENCE_AUTH_PROXY_EMAIL_HEADER): ${pages.join(', ')}`
		);
	}

	if (identityMode() === 'header') {
		if (!plainHeaderTrusted()) {
			throw new Error(
				'EVIDENCE_AUTH_PROXY_EMAIL_HEADER is set without JWT verification. Row filters need a verified ' +
					'identity: configure EVIDENCE_AUTH_PROXY_JWT_JWKS_URL, or set ' +
					'EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER=true if only the proxy can reach this server.'
			);
		}
		console.warn(
			'EVIDENCE_AUTH_PROXY_TRUST_PLAIN_HEADER=true: row filters trust an unsigned identity header.'
		);
	}

	const connection = await loadConnectionConfig(getProjectCwd()).catch(() => null);
	if (!supportsRowFilters(connection?.type)) {
		throw new Error(
			`\`auth.rows\` filters need a DuckDB or MotherDuck connection` +
				`${connection ? ` (this project uses ${connection.type})` : ''}: ${pages.join(', ')}`
		);
	}
};

// Serve-mode perimeter: basic auth gate + hardened headers. All traffic —
// static assets, SSR pages, and the /api/query SQL relay — flows through
// hooks, so this is the single choke point. Per-page query authorization
// happens in the /api/query route itself (row-security.server.ts).
export const handle: Handle = async ({ event, resolve }) => {
	if (event.request.method === 'GET') {
		const staticResponse = await serveProjectStatic(event.url.pathname);
		if (staticResponse) {
			if (isServeMode()) {
				if (basicAuthConfigured() && !checkBasicAuth(event.request.headers.get('authorization'))) {
					return new Response('Unauthorized', {
						status: 401,
						headers: { 'WWW-Authenticate': 'Basic realm="evidence"' }
					});
				}
				for (const [k, v] of Object.entries(SERVE_HARDENED_HEADERS)) {
					staticResponse.headers.set(k, v);
				}
			}
			return staticResponse;
		}
	}

	if (isServeMode()) {
		const path = event.url.pathname;
		if (SERVE_DISABLED_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
			return new Response('Not Found', { status: 404 });
		}

		if (basicAuthConfigured() && !checkBasicAuth(event.request.headers.get('authorization'))) {
			return new Response('Unauthorized', {
				status: 401,
				headers: { 'WWW-Authenticate': 'Basic realm="evidence"' }
			});
		}

		const response = await resolve(event);
		for (const [k, v] of Object.entries(SERVE_HARDENED_HEADERS)) {
			response.headers.set(k, v);
		}
		return response;
	}

	return resolve(event);
};
