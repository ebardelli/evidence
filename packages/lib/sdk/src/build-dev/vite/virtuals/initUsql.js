import { initDB, initializeFromManifest, query } from '@evidence-dev/universal-sql/client-duckdb';

import { getManifest } from '$evidence/static-assets';

const initPromise = (async () => {
	console.log('[initUsql] Starting initialization');
	await initDB();
	let res;
	// TODO: Optionally take in a filepath and/or URL for the manifest
	res = await getManifest();
	console.log('[initUsql] Raw manifest response:', typeof res, res.length, 'bytes');
	res = JSON.parse(res);
	console.log('[initUsql] Manifest backend:', res.backend);
	await initializeFromManifest(res);
	if (!res.databaseFile && !res.renderedFiles) console.error('No fixture data available!');
	// Test Query
	console.log('[initUsql] Running test query');
	const testResult = await query('SELECT * FROM information_schema.tables');
	console.log('[initUsql] Universal SQL initialized, found', testResult.length, 'tables');
	console.log('Universal SQL has been initialized successfully');
})();

export default initPromise;
