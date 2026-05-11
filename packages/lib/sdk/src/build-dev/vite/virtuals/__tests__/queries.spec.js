import { describe, expect, it, vi } from 'vitest';
import { waitForQueryUpdate } from '../query-timing.js';

describe('waitForQueryUpdate', () => {
	it('waits for the query promise during SSR', () => {
		const fetchPromise = Promise.resolve('done');
		expect(waitForQueryUpdate(fetchPromise)).toBe(fetchPromise);
	});

	it('keeps the browser loading delay', async () => {
		const originalWindow = globalThis.window;
		vi.stubGlobal('window', {});

		try {
			const fetchPromise = Promise.resolve('done');
			const raced = waitForQueryUpdate(fetchPromise);
			expect(raced).not.toBe(fetchPromise);
			await expect(raced).resolves.toBe('done');
		} finally {
			if (originalWindow === undefined) {
				vi.unstubAllGlobals();
			} else {
				vi.stubGlobal('window', originalWindow);
			}
		}
	});
});
