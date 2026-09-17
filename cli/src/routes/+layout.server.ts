/**
 * Layout server load - provides navigation items and org info to all pages
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import type { LayoutServerLoad } from './$types';
import { getNavItems } from '$lib/markdown/files.server';
import { loadCredentials } from '$lib/auth/credentials.server';
import { getProjectCwd } from '$lib/server/project-cwd';
import { isServeMode } from '$lib/server/serve-mode';
import { loadConnectionConfig } from '$cli/connection';
import { loadProjectConfig } from '$cli/project-config/load-config';
import { resolveProjectTheme } from '$lib/server/theme.server';
import { selectLanguage } from '@evidence/core/translations/resolve-translations';
import { SIDEBAR_WIDTH_COOKIE_NAME } from '@evidence/core/shadcn/components/ui/sidebar/constants.js';
import { getTranslationLanguages } from '$lib/server/translations.server';
import { MIME_BY_EXTENSION } from '$lib/mime-by-extension';
import type { WarehouseType } from '@evidence/core/sql-dialect';
const PUBLIC_STUDIO_HOST = process.env.PUBLIC_STUDIO_HOST ?? 'https://evidence.studio';

const STUDIO_HOST = PUBLIC_STUDIO_HOST.replace(/\/$/, '');

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

export const load: LayoutServerLoad = async ({ url, cookies }) => {
	const cwd = getProjectCwd();
	const isServe = isServeMode();
	const navItems = await getNavItems(cwd);
	// Serve mode ships only with connection.yaml projects, so there is no
	// Studio session to load and no org lookup to make.
	const credentials = isServe ? null : await loadCredentials();
	const connectionConfig = await loadConnectionConfig(cwd).catch(() => null);
	const connectionType: WarehouseType | null = connectionConfig?.type ?? null;
	const hasLocalConnection = existsSync(path.join(cwd, 'connection.yaml'));
	const projectConfig = await loadProjectConfig(cwd).catch(() => null);
	// Explicit `title:` in evidence.config.yaml overrides the sidebar header
	// (which otherwise shows the Studio org name, or "Evidence").
	const siteTitle = projectConfig?.title ?? null;
	// Explicit `favicon:` (a project-root-relative path) overrides the default
	// Evidence favicon, served through a dedicated route (see
	// routes/__evidence/favicon) so it can't collide with the CLI's own
	// bundled favicon.svg.
	const favicon = projectConfig?.favicon
		? {
				href: '/__evidence/favicon',
				type: MIME_BY_EXTENSION[path.extname(projectConfig.favicon).toLowerCase()] ?? 'image/x-icon'
			}
		: null;
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
		siteTitle,
		favicon,
		resolvedTheme,
		languages,
		currentLanguage,
		sidebarWidthPx,
		user: credentials?.user ?? null,
		organizationId,
		organizationName,
		organizations,
		connectionType,
		hasLocalConnection,
		isServe
	};
};
