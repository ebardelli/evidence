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

/**
 * @param {string} url
 */
const fetchManifestText = async (url) => {
	const response = await fetch(addBasePath(url));
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
