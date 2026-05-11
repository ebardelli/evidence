/**
 * SSR and prerendering must wait for query completion so the page tree and
 * prerendered route data are fully materialized before SvelteKit decides which
 * paths exist. In the browser we keep the loading-state delay.
 *
 * @template T
 * @param {Promise<T>} fetchPromise
 * @returns {Promise<T>}
 */
export const waitForQueryUpdate = (fetchPromise) => {
	if (typeof window === 'undefined') return fetchPromise;

	return Promise.race([
		fetchPromise,
		new Promise((resolve) => {
			setTimeout(resolve, 500);
		})
	]);
};
