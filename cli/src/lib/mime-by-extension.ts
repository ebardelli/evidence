/**
 * Content types by file extension. Shared between server-side static asset
 * serving and client/server-isomorphic code (e.g. the favicon `<link>`), so
 * it must not import any server-only or Node built-in APIs.
 */
export const MIME_BY_EXTENSION: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.pdf': 'application/pdf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.txt': 'text/plain'
};
