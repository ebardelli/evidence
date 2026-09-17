/**
 * Serves the project's custom favicon (the `favicon:` key in evidence.config.yaml).
 *
 * A dedicated route rather than relying on the project's static/ dir being
 * served under its own name: a project favicon named `favicon.svg` would
 * otherwise collide with (and lose to) the CLI's own bundled default asset
 * of the same name.
 */
import { redirect } from '@sveltejs/kit';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assets } from '$app/paths';
import type { RequestHandler } from './$types';
import { getProjectCwd } from '$lib/server/project-cwd';
import { loadProjectConfig } from '$cli/project-config/load-config';
import { MIME_BY_EXTENSION } from '$lib/mime-by-extension';

export const GET: RequestHandler = async () => {
	const cwd = getProjectCwd();
	const defaultFavicon = `${assets}/favicon.svg`;

	const config = await loadProjectConfig(cwd).catch(() => null);
	const configuredPath = config?.favicon;
	if (!configuredPath) redirect(302, defaultFavicon);

	// Confine to the project root (real path, so a symlink can't escape it).
	const root = path.resolve(cwd);
	const resolved = path.resolve(root, configuredPath);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		redirect(302, defaultFavicon);
	}

	let real: string;
	try {
		real = await realpath(resolved);
	} catch {
		redirect(302, defaultFavicon);
	}
	const realRoot = await realpath(root);
	if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
		redirect(302, defaultFavicon);
	}

	const stats = await stat(real).catch(() => null);
	if (!stats?.isFile()) redirect(302, defaultFavicon);

	const contentType = MIME_BY_EXTENSION[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
	const body = await readFile(real);
	return new Response(new Uint8Array(body), {
		headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' }
	});
};
