<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { setQueryService } from '@evidence/core/QueryService.context';
	import { setProjectSettingsContext } from '@evidence/core/project-settings.context';
	import { setPageSettingsContext } from '@evidence/core/page-settings.context';
	import { setAutoRefreshContext } from '@evidence/core/auto-refresh.context.svelte';
	import type {
		PageSettings,
		ProjectSettings
	} from '@evidence/core/user-components/interfaces/project-settings';
	import { createPageFiltersContext } from '@evidence/core/page-filters-context';
	import {
		createInlineQueriesContext,
		type SqlFiles
	} from '@evidence/core/user-components/common/inline-queries';
	import { setPageState } from '@evidence/core/shims/page-state';
	import { setShowErrorsContext } from '@evidence/core/show-errors.context';
	import { Metadata, setMetadataContext } from '@evidence/core/metadata';
	import {
		InlineQueryMetadata,
		setInlineQueryMetadataContext
	} from '@evidence/core/metadata/inline-query-metadata.svelte';
	import { createMetricsCatalogContext } from '@evidence/core/metrics/metrics-catalog';
	import { WasmQueryService } from '$lib/services/WasmQueryService';
	import type { Snippet } from 'svelte';
	import type { SerializedFilters } from '@evidence/core/Filters.svelte';

	interface Props {
		serializedInlineQueries?: Record<string, string>;
		serializedFilters?: SerializedFilters;
		sqlFiles?: SqlFiles;
		basePath?: string;
		useRelativeResolution?: boolean;
		/** metrics/*.yaml discovered from the project root, keyed by path. */
		metricFiles?: Record<string, string>;
		pageSettings?: PageSettings;
		projectSettings?: ProjectSettings & { computedDefaultDateRangeEnd?: string };
		children: Snippet;
	}

	let {
		serializedInlineQueries = {},
		serializedFilters = {},
		sqlFiles = {},
		basePath,
		useRelativeResolution = false,
		metricFiles = {},
		pageSettings = {},
		projectSettings = { first_day_of_week: 'sunday' },
		children
	}: Props = $props();

	setPageState({
		route: { id: '/static' },
		url:
			typeof window !== 'undefined' ? new URL(window.location.href) : new URL('http://localhost'),
		params: {},
		data: {},
		status: 200,
		error: null,
		form: null
	});

	// No error overlays in a deployed static site.
	setShowErrorsContext(false);

	// WasmQueryService loads Parquet files from the same origin as the page.
	const queryService = new WasmQueryService();
	setQueryService(queryService);

	// Metadata introspection is a no-op for static — warehouseMode 'managed'
	// keeps the Metadata instance from issuing warehouse-specific catalog queries.
	const metadata = new Metadata(queryService, { warehouseMode: 'managed' });
	setMetadataContext(metadata);

	setProjectSettingsContext(() => projectSettings);
	setPageSettingsContext(() => pageSettings);
	setAutoRefreshContext(() => pageSettings);

	// Filters sync to the URL so shared links preserve the active filter state.
	const pageFilters = createPageFiltersContext(serializedFilters, {
		url: () => (browser ? new URL(window.location.href) : page.url),
		updateUrl: (url) => {
			window.history.replaceState(window.history.state, '', url.toString());
		}
	});
	const inlineQueries = createInlineQueriesContext(
		{ filterContexts: [pageFilters] },
		serializedInlineQueries,
		sqlFiles,
		undefined,
		{ basePath, useRelativeResolution }
	);

	const inlineQueryMetadata = new InlineQueryMetadata(queryService, {
		inlineQueries,
		pageFilters
	});
	setInlineQueryMetadataContext(inlineQueryMetadata);

	const metricsCatalog = createMetricsCatalogContext(metricFiles);
	$effect(() => {
		metricsCatalog.setFromYaml(metricFiles);
	});

	$effect(() => {
		inlineQueryMetadata.loadAllDebounced();
	});
</script>

{@render children()}
