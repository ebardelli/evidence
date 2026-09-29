// @vitest-environment jsdom
/**
 * A chart whose inline query references a dropdown filter (`{{win}}`) used to
 * run before the dropdown's `select_first` default resolved, interpolating an
 * empty value (`and w = `) and surfacing a parser error. While the filter is
 * pending, Query must hold its loading state and not execute; once the default
 * lands it runs exactly once with the resolved value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { Query, type QueryDependencies } from './Query.svelte';
import type { QueryResult } from './user-components/interfaces/query-service';
import { ClickHouseDialect } from './sql-dialect';
import { Filters } from './Filters.svelte';
import { DropdownFilter } from './user-components/tags/dropdown/DropdownFilter.svelte';
import type { FilterDeps } from './Filter.svelte';
import { InlineQueries } from './user-components/common/inline-queries';
import { processColumnExpression } from './user-components/common/sql-expression-utils';
import type { SQLQueryConfig } from './user-components/common/sql-options';
import {
	interpolateQueryStrings,
	PENDING_FILTER_MARKER,
	hasPendingFilter
} from './interpolate-query-strings';

const DEBOUNCE = 500;

async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	flushSync();
}

function setup() {
	const dialect = new ClickHouseDialect();
	const filterDeps: FilterDeps = {
		url: undefined,
		updateUrl: undefined,
		projectSettings: undefined,
		dialect: () => dialect
	};
	const pageFilters = new Filters(filterDeps);
	const win = pageFilters.create(
		{
			id: 'win',
			userComponentName: 'dropdown',
			attributes: { value_column: 'w', multiple: false }
		} as ConstructorParameters<typeof DropdownFilter>[0],
		DropdownFilter
	);
	const inlineQueries = new InlineQueries({ filterContexts: [pageFilters] });
	inlineQueries.set('by_window', 'select * from t where 1=1 and w = {{win}}');
	return { dialect, pageFilters, win, inlineQueries };
}

describe('pending filter defaults', () => {
	it('marks interpolated sql only while the filter is pending', () => {
		const { pageFilters, win, inlineQueries } = setup();
		const sql = 'select * from t where w = {{win}}';

		expect(hasPendingFilter(interpolateQueryStrings(sql, [pageFilters], inlineQueries).sql)).toBe(
			false
		);

		win.setPending(true);
		const pending = interpolateQueryStrings(sql, [pageFilters], inlineQueries);
		expect(pending.pendingFilters).toEqual(['win']);
		expect(pending.sql).toContain(PENDING_FILTER_MARKER);
		// Text context (titles etc.) never gets the marker.
		expect(interpolateQueryStrings(sql, [pageFilters], inlineQueries, 'text').sql).not.toContain(
			PENDING_FILTER_MARKER
		);

		// Pending clears as soon as a value exists, even before the flag is reset.
		win.setDefault('2024');
		expect(win.pending).toBe(false);
		expect(hasPendingFilter(interpolateQueryStrings(sql, [pageFilters], inlineQueries).sql)).toBe(
			false
		);
	});

	describe('Query', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('stays loading without executing until the default resolves', async () => {
			const { dialect, pageFilters, win, inlineQueries } = setup();
			win.setPending(true);

			const runQuery = vi.fn(
				async (): Promise<QueryResult> => ({
					rows: [{ w: '2024' }] as never,
					columns: [],
					error: null
				})
			);
			const deps: QueryDependencies = {
				connection: {
					id: 'default',
					type: 'managed',
					dialect,
					query: runQuery as QueryDependencies['connection']['query']
				},
				filterContexts: [pageFilters],
				inlineQueries,
				projectSettings: undefined,
				defaultRefreshInterval: undefined
			};

			let query!: Query;
			const cleanup = $effect.root(() => {
				const config: SQLQueryConfig = {
					tableExpressionName: 'by_window',
					columns: [processColumnExpression({ value: 'w' }, dialect)].filter((c) => c !== null),
					filterIds: undefined,
					where: undefined,
					having: undefined,
					qualify: undefined,
					order: undefined,
					limit: undefined,
					date_range: undefined
				};
				query = new Query(() => config, deps, { debounce: DEBOUNCE });
			});

			flushSync();
			vi.advanceTimersByTime(DEBOUNCE * 2);
			await settle();

			expect(runQuery).not.toHaveBeenCalled();
			expect(query.loading).toBe(true);
			expect(query.error).toBeNull();

			win.setDefault('2024');
			win.setPending(false);
			flushSync();
			vi.advanceTimersByTime(DEBOUNCE);
			await settle();

			expect(runQuery).toHaveBeenCalledTimes(1);
			const sent = (runQuery.mock.calls[0] as unknown[])[0] as string;
			expect(sent).toContain("'2024'");
			expect(sent).not.toContain(PENDING_FILTER_MARKER);
			expect(query.loading).toBe(false);

			cleanup();
		});
	});
});
