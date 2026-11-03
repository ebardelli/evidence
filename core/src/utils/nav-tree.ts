/**
 * Normalized navigation tree shared by the Studio published viewer and the
 * CLI dev-server preview. Both surfaces map their own data shapes into a
 * `NavTree` and hand it to `PageNavTree.svelte`, which renders the shadcn
 * sidebar markup. This keeps the tree presentation in one place while letting
 * each caller build hrefs however it needs (branch-aware in Studio, plain
 * slugs in the CLI).
 */

import { deslugify } from './deslugify';

/**
 * Canonical sidebar ordering: pages with an explicit `sidebar_position` sort
 * first (ascending), ties and unpositioned pages fall back to name order. Shared
 * by the Studio published/preview viewers and the CLI dev server so the sidebar
 * orders identically everywhere a `sidebar_position` frontmatter value is read.
 */
export function compareSidebarPosition(
	aPos: number | null | undefined,
	bPos: number | null | undefined,
	aName: string,
	bName: string
): number {
	if (aPos !== null && aPos !== undefined && bPos !== null && bPos !== undefined) {
		return aPos === bPos ? aName.localeCompare(bName) : aPos - bPos;
	}
	if (aPos !== null && aPos !== undefined) return -1;
	if (bPos !== null && bPos !== undefined) return 1;
	return aName.localeCompare(bName);
}

export interface NavPage {
	name: string;
	href: string;
	icon?: string | null;
}

export interface NavDirectory {
	id: string;
	name: string;
	/** The folder's index page, linked from the directory heading. */
	href?: string | null;
	/** Pages and nested directories, in sidebar order. */
	pages: NavEntry[];
}

export type NavEntry = NavPage | NavDirectory;

export function isNavDirectory(entry: NavEntry): entry is NavDirectory {
	return 'pages' in entry;
}

export interface NavTree {
	rootPages: NavPage[];
	directories: NavDirectory[];
}

// --- Studio mapping ---------------------------------------------------------

interface SidebarProjectPage {
	name: string;
	slug: string | null;
	directoryId?: number;
	settings?: { icon?: string | null } | null;
}

interface SidebarDirectory {
	id: number | string;
	name: string;
	slug: string;
}

export interface SidebarProjectInput {
	rootPages: SidebarProjectPage[];
	secondLevelDirectories: SidebarDirectory[];
	secondLevelPages: SidebarProjectPage[];
}

/**
 * Map a Studio project (root pages + second-level directories/pages) into a
 * `NavTree`. `hrefFor` receives a project-relative slug path (e.g. `"orders"`
 * or `"sales/regional"`) and returns the full URL, so the caller owns
 * branch encoding and org/project prefixing.
 */
export function toNavTreeFromProject(
	project: SidebarProjectInput,
	hrefFor: (relSlug: string) => string
): NavTree {
	const rootPages: NavPage[] = project.rootPages
		.filter((p) => p.slug !== null)
		.map((p) => ({
			name: p.name,
			href: hrefFor(p.slug as string),
			icon: p.settings?.icon ?? null
		}));

	const directories: NavDirectory[] = project.secondLevelDirectories
		.map((dir) => ({
			id: String(dir.id),
			name: dir.name,
			pages: project.secondLevelPages
				.filter((p) => String(p.directoryId) === String(dir.id) && p.slug !== null)
				.map((p) => ({
					name: p.name,
					href: hrefFor(`${dir.slug}/${p.slug}`),
					icon: p.settings?.icon ?? null
				}))
		}))
		.filter((dir) => dir.pages.length > 0);

	return { rootPages, directories };
}

// --- CLI mapping ------------------------------------------------------------

export interface FlatNavItem {
	name: string;
	slug: string;
	isHome: boolean;
	/** Frontmatter `title`; overrides the deslugified filename when present. */
	title?: string;
	/** Frontmatter `sidebar_label`; overrides `title` in the sidebar. */
	sidebarLabel?: string;
	/** Frontmatter `icon`; rendered in the sidebar icon column. */
	icon?: string | null;
}

/**
 * Build a `NavTree` from the CLI's flat list of discovered pages. Slugs
 * without a `/` become root pages; nested slugs become directories that
 * mirror the folder structure. A folder's `index` page is not listed as a
 * page: it names the directory and its heading links to it. Items are
 * emitted in the order given (a directory sits where its first page does),
 * so the caller is responsible for sorting (e.g. by `sidebar_position`) first.
 */
export function buildNavTreeFromFlat(items: FlatNavItem[]): NavTree {
	const rootPages: NavPage[] = [];
	const directories: NavDirectory[] = [];
	const dirsById = new Map<string, NavDirectory>();
	// PageNavTree keys its `{#each}` on `href`, so duplicates crash hydration
	// with each_key_duplicate. Callers *should* dedupe upstream, but keep the
	// sidebar defensive so a malformed input degrades to a first-wins nav
	// instead of taking the client down.
	const seenHrefs = new Set<string>();

	function directoryFor(segments: string[]): NavDirectory {
		const id = segments.join('/');
		const existing = dirsById.get(id);
		if (existing) return existing;
		const dir: NavDirectory = { id, name: deslugify(segments[segments.length - 1]), pages: [] };
		dirsById.set(id, dir);
		if (segments.length === 1) directories.push(dir);
		else directoryFor(segments.slice(0, -1)).pages.push(dir);
		return dir;
	}

	for (const item of items) {
		const segments = item.slug.split('/');
		const isFolderIndex = !item.isHome && segments.length > 1 && item.name === 'index';
		const href = item.isHome
			? '/'
			: isFolderIndex
				? `/${segments.slice(0, -1).join('/')}`
				: `/${item.slug}`;
		if (seenHrefs.has(href)) continue;
		seenHrefs.add(href);
		const displayName =
			item.sidebarLabel ?? item.title ?? (item.isHome ? 'Home' : deslugify(item.name));

		if (item.isHome || segments.length === 1) {
			rootPages.push({ name: displayName, href, icon: item.icon ?? null });
			continue;
		}

		const dir = directoryFor(segments.slice(0, -1));
		if (isFolderIndex) {
			dir.name = displayName;
			dir.href = href;
		} else {
			dir.pages.push({ name: displayName, href, icon: item.icon ?? null });
		}
	}

	return { rootPages, directories };
}
