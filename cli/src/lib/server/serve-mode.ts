/**
 * Serve mode (`evidence serve`) is set by the CLI entrypoint via EVIDENCE_SERVE
 * before the embedded SvelteKit app boots. Routes/hooks read it to strip dev
 * machinery and disable the Studio-login surface.
 */
export function isServeMode(): boolean {
	return !!process.env.EVIDENCE_SERVE;
}

export function basicAuthConfigured(): boolean {
	return !!(process.env.EVIDENCE_BASIC_USER && process.env.EVIDENCE_BASIC_PASSWORD);
}

/**
 * Static export (`evidence export`) renders every page in-process with
 * EVIDENCE_STATIC set (alongside EVIDENCE_SERVE, for the same immutable-content
 * behavior). Pages then run their queries in the browser via DuckDB-WASM.
 * EVIDENCE_STATIC_BASE is the URL prefix the site is hosted under ('' at the root).
 */
export function staticBase(): string | null {
	if (!process.env.EVIDENCE_STATIC) return null;
	return (process.env.EVIDENCE_STATIC_BASE ?? '').replace(/\/$/, '');
}
