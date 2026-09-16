/**
 * Layout server load - provides navigation items and org info to all pages
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getNavItems } from '$lib/markdown/files.server';
import { loadCredentials } from '$lib/auth/credentials.server';
import { getProjectCwd } from '$lib/server/project-cwd';
import { isServeMode } from '$lib/server/serve-mode';
import {
	getProxyUser,
	getProxyLoginUrl,
	getProxyLogoutUrl,
	proxyAuthConfigured
} from '$lib/server/proxy-auth.server';
import { loadConnectionConfig } from '$cli/connection';
import { loadProjectConfig } from '$cli/project-config/load-config';
import { resolveProjectTheme } from '$lib/server/theme.server';
import { selectLanguage } from '@evidence/core/translations/resolve-translations';
import { SIDEBAR_WIDTH_COOKIE_NAME } from '@evidence/core/shadcn/components/ui/sidebar/constants.js';
import { getTranslationLanguages } from '$lib/server/translations.server';
import type { WarehouseType } from '@evidence/core/sql-dialect';
const PUBLIC_STUDIO_HOST = process.env.PUBLIC_STUDIO_HOST ?? 'https://evidence.studio';

const STUDIO_HOST = PUBLIC_STUDIO_HOST.replace(/\/$/, '');

// Guards the EVIDENCE_AUTH_PROXY_LOGIN_URL redirect below against a tight
// browser↔proxy loop: if the proxy's own session is already valid but the
// identity it forwards to Evidence keeps failing verification (a persistent
// issuer/audience misconfiguration, not a lapsed session), redirecting again
// just bounces straight back with the same bad identity. One redirect is
// allowed per cookie lifetime; a second failure within it falls through to
// the ordinary degraded/403 behavior instead of redirecting forever.
const AUTH_REDIRECT_LOOP_COOKIE = 'evidence_auth_redirect_attempted';

// Org info is fetched once at startup and cached for the session
let orgCache: {
	organizationId: string | null;
	organizationName: string | null;
	organizations: { id: string; name: string }[];
} | null = null;

async function getOrgInfo(refreshToken: string, storedOrgId: string | null) {
	if (orgCache) return orgCache;

	let organizationId = storedOrgId;
	let organizationName: string | null = null;
	let organizations: { id: string; name: string }[] = [];

	try {
		const res = await fetch(`${STUDIO_HOST}/api/cli/organizations`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken })
		});
		if (res.ok) {
			const data = await res.json();
			organizations = data.organizations ?? [];

			if (data.organizationId) {
				organizationId = data.organizationId;
			}

			organizationName = organizations.find((o) => o.id === organizationId)?.name ?? null;
		}
	} catch {
		/* degrade gracefully */
	}

	orgCache = { organizationId, organizationName, organizations };
	return orgCache;
}

export const load: LayoutServerLoad = async ({ url, cookies, request }) => {
	const cwd = getProjectCwd();
	const isServe = isServeMode();
	const navItems = await getNavItems(cwd);
	// Serve mode ships only with connection.yaml projects, so there is no
	// Studio session to load and no org lookup to make.
	const credentials = isServe ? null : await loadCredentials();
	// Cosmetic sidebar identity forwarded by a fronting authenticating proxy;
	// see proxy-auth.server.ts for the trust model.
	const proxyUser = isServe ? await getProxyUser(request.headers) : null;

	// Proxy auth is configured but this request came in with no usable
	// identity — a missing/expired JWT, or a blank header because the
	// proxy's own session lapsed. Bounce through EVIDENCE_AUTH_PROXY_LOGIN_URL
	// (typically the proxy's sign-in endpoint) rather than quietly falling
	// back to the "not logged in" sidebar state below. `{returnTo}` in the
	// configured URL is replaced with the page the viewer was headed to, so
	// the proxy can send them back after signing in. No-op unless both proxy
	// auth and the login URL are configured, so this is opt-in.
	if (isServe && !proxyUser && proxyAuthConfigured()) {
		const loginUrl = getProxyLoginUrl();
		if (loginUrl && !cookies.get(AUTH_REDIRECT_LOOP_COOKIE)) {
			cookies.set(AUTH_REDIRECT_LOOP_COOKIE, '1', { path: '/', maxAge: 10 });
			const returnTo = `${url.pathname}${url.search}`;
			redirect(302, loginUrl.replaceAll('{returnTo}', encodeURIComponent(returnTo)));
		}
	}

	const connectionConfig = await loadConnectionConfig(cwd).catch(() => null);
	const connectionType: WarehouseType | null = connectionConfig?.type ?? null;
	const hasLocalConnection = existsSync(path.join(cwd, 'connection.yaml'));
	const projectConfig = await loadProjectConfig(cwd).catch(() => null);
	const projectName = projectConfig?.project.name ?? null;
	// Read theme.yaml directly so a broken evidence.config.yaml doesn't drop a valid theme.
	const resolvedTheme = await resolveProjectTheme(cwd);

	const languages = await getTranslationLanguages(cwd);
	const currentLanguage = selectLanguage(
		languages,
		url.searchParams.get('lang') ?? cookies.get('lang') ?? null
	);

	// Pass the persisted sidebar width to SSR so the rendered width matches the
	// client (which reads the same cookie), avoiding a hydration width jump.
	const sidebarWidthPx = parseInt(cookies.get(SIDEBAR_WIDTH_COOKIE_NAME) ?? '', 10) || undefined;

	let organizationId: string | null = credentials?.organizationId ?? null;
	let organizationName: string | null = null;
	let organizations: { id: string; name: string }[] = [];

	if (credentials?.refreshToken) {
		const orgInfo = await getOrgInfo(credentials.refreshToken, credentials.organizationId);
		organizationId = orgInfo.organizationId;
		organizationName = orgInfo.organizationName;
		organizations = orgInfo.organizations;
	}

	return {
		navItems,
		projectName,
		resolvedTheme,
		languages,
		currentLanguage,
		sidebarWidthPx,
		user: credentials?.user ?? proxyUser,
		// Only set for a proxy-forwarded identity, not a Studio-login user —
		// signing out of the proxy's session (e.g. oauth2-proxy's
		// `/oauth2/sign_out`) has nothing to do with `evidence login`/`logout`.
		proxyLogoutUrl: proxyUser ? getProxyLogoutUrl() : null,
		organizationId,
		organizationName,
		organizations,
		connectionType,
		hasLocalConnection,
		isServe
	};
};
