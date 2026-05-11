import { afterEach, describe, expect, it, vi } from 'vitest';
import { getManifest } from '../browser/static-assets.js';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('browser getManifest', () => {
	it('returns manifest from _evidence endpoint when available', async () => {
		const fetch = vi.fn(async (url) => {
			if (url !== '/_evidence/manifest.json') throw new Error('Unexpected URL');
			return {
				ok: true,
				headers: { get: () => 'application/json' },
				text: async () => '{"backend":"duckdb"}'
			};
		});
		vi.stubGlobal('fetch', fetch);

		await expect(getManifest()).resolves.toBe('{"backend":"duckdb"}');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith('/_evidence/manifest.json');
	});

	it('falls back to /data manifest when _evidence returns html 404', async () => {
		const fetch = vi.fn(async (url) => {
			if (url === '/_evidence/manifest.json') {
				return {
					ok: false,
					headers: { get: () => 'text/html' },
					text: async () => '<!doctype html><html><body>404</body></html>'
				};
			}
			if (url === '/data/manifest.json') {
				return {
					ok: true,
					headers: { get: () => 'application/json' },
					text: async () => '{"backend":"duckdb","databaseFile":{"url":"static/data/evidence.duckdb"}}'
				};
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetch);

		await expect(getManifest()).resolves.toContain('"backend":"duckdb"');
		expect(fetch).toHaveBeenNthCalledWith(1, '/_evidence/manifest.json');
		expect(fetch).toHaveBeenNthCalledWith(2, '/data/manifest.json');
	});
});
