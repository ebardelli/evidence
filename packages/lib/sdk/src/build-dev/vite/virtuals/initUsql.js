import { initDB, initializeFromManifest, query } from '@evidence-dev/universal-sql/client-duckdb';

import { getManifest } from '$evidence/static-assets';

/**
 * @param {string} path
 */
const addBasePath = (path) => {
	if (path.startsWith('http')) return path;
	if (/^[^/]*:/.test(path)) return path;
	const rawBase = import.meta.env.BASE_URL ?? '/';
	if (!rawBase || rawBase === '/') return path;
	const base = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase;
	if (path.startsWith(base)) return path;
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return `${base}${normalizedPath}`;
};

const initPromise = (async () => {
	console.log('[initUsql] Starting initialization');
	await initDB();
	let res;
	// TODO: Optionally take in a filepath and/or URL for the manifest
	res = await getManifest();
	console.log('[initUsql] Raw manifest response:', typeof res, res.length, 'bytes');
	res = JSON.parse(res);
	console.log('[initUsql] Manifest backend:', res.backend);
	await initializeFromManifest(res, { addBasePath });
	if (!res.databaseFile && !res.renderedFiles) console.error('No fixture data available!');
	// Test Query
	console.log('[initUsql] Running test query');
	const testResult = await query('SELECT * FROM information_schema.tables');
	console.log('[initUsql] Universal SQL initialized, found', testResult.length, 'tables');
	console.log('Universal SQL has been initialized successfully');
})();

export default initPromise;
