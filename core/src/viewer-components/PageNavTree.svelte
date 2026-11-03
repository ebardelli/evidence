<script lang="ts">
	import * as Sidebar from '../shadcn/components/ui/sidebar';
	import { ChevronRight } from 'lucide-svelte';
	import Ellipsis from './Ellipsis.svelte';
	import { loadLucideIcon } from '../user-components/common/dynamic-icon';
	import {
		isNavDirectory,
		type NavTree,
		type NavDirectory,
		type NavPage
	} from '../utils/nav-tree';

	let { tree, currentPath }: { tree: NavTree; currentPath: string } = $props();

	// Per-directory collapse state. Default: expanded when it contains the
	// active page, collapsed otherwise. Once the user toggles a directory we
	// honour their explicit choice (mirrors the published viewer).
	let collapsedDirectories = $state<Record<string, boolean>>({});

	function dirHasActivePage(dir: NavDirectory): boolean {
		if (dir.href === currentPath) return true;
		return dir.pages.some((entry) =>
			isNavDirectory(entry) ? dirHasActivePage(entry) : entry.href === currentPath
		);
	}

	// A folder only acts as a folder (chevron + collapsible children) when
	// something is nested under it. A folder holding just its index page is
	// shown as a plain page link, and one with nothing to show is hidden.
	function hasChildren(dir: NavDirectory): boolean {
		return dir.pages.some((entry) => !isNavDirectory(entry) || isVisible(entry));
	}

	function isVisible(dir: NavDirectory): boolean {
		return !!dir.href || hasChildren(dir);
	}

	function isDirectoryCollapsed(dir: NavDirectory): boolean {
		if (collapsedDirectories[dir.id] === undefined) {
			return !dirHasActivePage(dir);
		}
		return collapsedDirectories[dir.id];
	}

	function toggleDirectory(dir: NavDirectory) {
		collapsedDirectories = {
			...collapsedDirectories,
			[dir.id]: !isDirectoryCollapsed(dir)
		};
	}
</script>

{#snippet pageIcon(navPage: NavPage, isActive: boolean)}
	{@const tone = isActive ? 'text-primary' : 'text-muted-foreground/80'}
	{#if navPage.icon}
		{@const IconComponent = loadLucideIcon(navPage.icon)}
		{#if IconComponent}
			<IconComponent class="h-4 w-4 {tone}" />
		{/if}
	{/if}
{/snippet}

{#snippet pageLink(navPage: NavPage)}
	{@const isActive = navPage.href === currentPath}
	<Sidebar.MenuButton {isActive}>
		{#snippet child({ props })}
			<a href={navPage.href} {...props}>
				{@render pageIcon(navPage, isActive)}
				<Ellipsis class="w-full cursor-pointer">
					{navPage.name}
				</Ellipsis>
			</a>
		{/snippet}
	</Sidebar.MenuButton>
{/snippet}

{#snippet directory(dir: NavDirectory)}
	{@const collapsed = isDirectoryCollapsed(dir)}
	{#if !hasChildren(dir)}
		{#if dir.href}
			{@render pageLink({ name: dir.name, href: dir.href })}
		{/if}
	{:else if dir.href}
		<!-- Linked heading: the chevron toggles, the name opens the folder's index page. -->
		<Sidebar.MenuButton isActive={dir.href === currentPath}>
			{#snippet child({ props })}
				<div {...props}>
					<button
						type="button"
						class="-m-1 shrink-0 rounded p-1"
						aria-label="{collapsed ? 'Expand' : 'Collapse'} {dir.name}"
						aria-expanded={!collapsed}
						onclick={() => toggleDirectory(dir)}
					>
						<ChevronRight
							class="h-3.5 w-3.5 transition-transform {!collapsed ? 'rotate-90' : ''}"
						/>
					</button>
					<a href={dir.href} class="min-w-0 flex-1">
						<Ellipsis class="w-full cursor-pointer">
							{dir.name}
						</Ellipsis>
					</a>
				</div>
			{/snippet}
		</Sidebar.MenuButton>
	{:else}
		<Sidebar.MenuButton>
			{#snippet child({ props })}
				<button
					type="button"
					{...props}
					aria-expanded={!collapsed}
					onclick={() => toggleDirectory(dir)}
				>
					<ChevronRight
						class="h-3.5 w-3.5 shrink-0 transition-transform {!collapsed ? 'rotate-90' : ''}"
					/>
					<Ellipsis class="w-full cursor-pointer">
						{dir.name}
					</Ellipsis>
				</button>
			{/snippet}
		</Sidebar.MenuButton>
	{/if}

	{#if !collapsed && hasChildren(dir)}
		<div class="my-1 border-l pl-1">
			{#each dir.pages as entry (isNavDirectory(entry) ? `dir:${entry.id}` : entry.href)}
				{#if isNavDirectory(entry)}
					{@render directory(entry)}
				{:else}
					{@render pageLink(entry)}
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

<Sidebar.Menu>
	<!-- Root pages -->
	{#each tree.rootPages as navPage (navPage.href)}
		<Sidebar.MenuItem>
			{@render pageLink(navPage)}
		</Sidebar.MenuItem>
	{/each}

	<!-- Directories and their pages -->
	{#each tree.directories as dir (dir.id)}
		<Sidebar.MenuItem>
			{@render directory(dir)}
		</Sidebar.MenuItem>
	{/each}
</Sidebar.Menu>
