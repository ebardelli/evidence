import { afterEach, describe, expect, it } from 'vitest';
import mockfs from 'mock-fs';
import { cache_for_hash, get_all_page_queries } from './cache-duckdb.js';
import fs from 'fs';

afterEach(() => {
	mockfs.restore();
});

describe('cache_for_hash', () => {
	it('falls back to an empty Arrow result when the query result is missing', () => {
		mockfs({});

		expect(() =>
			cache_for_hash('SELECT 1', undefined, {
				route_hash: 'route-hash',
				additional_hash: 'page-hash',
				query_name: 'broken_query',
				prerendering: true
			})
		).not.toThrow();

		const allQueries = JSON.parse(get_all_page_queries('route-hash', 'page-hash'));
		expect(allQueries).toHaveProperty('broken_query');
		expect(typeof allQueries.broken_query).toBe('string');

		expect(fs.existsSync(`.evidence-queries/cache/${allQueries.broken_query}.arrow`)).toBe(
			true
		);
	});
});
