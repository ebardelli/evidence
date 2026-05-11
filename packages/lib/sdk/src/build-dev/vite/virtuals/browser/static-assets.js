/**
 * @param {string} url
 */
const fetchManifestText = async (url) => {
	const response = await fetch(url);
	const text = await response.text();
	const contentType = response.headers?.get?.('content-type') ?? '';
	const isLikelyJson = contentType.includes('application/json') || text.trim().startsWith('{');

	if (!response.ok || !isLikelyJson) {
		throw new Error(`Failed to fetch manifest from ${url}`);
	}

	return text;
};


/**
 * @returns {Promise<string>}
 */
export const getManifest = async () => {
	try {
		return await fetchManifestText('/_evidence/manifest.json');
	} catch {
		return fetchManifestText('/data/manifest.json');
	}
};
