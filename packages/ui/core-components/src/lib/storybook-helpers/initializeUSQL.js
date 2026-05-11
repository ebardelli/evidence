import {
	initDB,
	loadDuckDBDatabase,
	setParquetURLs,
	updateSearchPath
} from '@evidence-dev/universal-sql/client-duckdb';
import { usesDatabaseFile } from '@evidence-dev/universal-sql';
import { addBasePath } from '@evidence-dev/sdk/utils/svelte';

export async function initialize() {
	try {
		await initDB();
		const res = await fetch(addBasePath('/data/manifest.json')).then((r) => r.json());
		if (usesDatabaseFile(res.backend) && res.databaseFile?.url) {
			await loadDuckDBDatabase(res.databaseFile.path ?? res.databaseFile.url, { addBasePath });
			await updateSearchPath(res.locatedSchemas ?? []);
		} else {
			await setParquetURLs(res.renderedFiles ?? {}, { addBasePath });
			await updateSearchPath(Object.keys(res.renderedFiles ?? {}));
			if (!res.renderedFiles) console.error('No fixture data available!');
		}
	} catch (e) {
		console.error('Failed to initialize USQL ', e);
	}
}
