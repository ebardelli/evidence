import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: {
		// Replaceable at build time by release.ts --dev so the dev binary bakes
		// in staging defaults. BUILD_QUERY_ENGINE_HOST controls the value.
		__DEFAULT_QUERY_ENGINE_HOST__: JSON.stringify(
			process.env.BUILD_QUERY_ENGINE_HOST ?? 'https://query-engine-service.evidence.studio'
		)
	},
	// Match studio: core's shims read PUBLIC_* vars off import.meta.env (e.g. PUBLIC_MAPBOX_TOKEN)
	envPrefix: ['VITE_', 'PUBLIC_'],
	resolve: {
		alias: {
			'@evidence/core': path.resolve(__dirname, '../core/src')
		}
	},
	server: {
		fs: {
			// Allow serving files from core
			allow: ['..']
		},
		watch: {
			// Ensure core changes trigger HMR
			ignored: ['!**/core/**']
		}
	},
	optimizeDeps: {
		// Don't pre-bundle @evidence/core - let Vite handle it
		exclude: ['@evidence/core'],
		// Pre-bundle deps that @evidence/core pulls in (it's excluded above, so
		// Vite can't discover these by crawling it). Without this they're found
		// mid-session on first import, triggering a re-optimize + the
		// `svelte_legacy.js` 404 cascade that breaks client-side hydration.
		include: ['svelte-sonner', 'html-to-image']
	},
	ssr: {
		// Bundle packages with Svelte components during SSR so they're processed properly
		noExternal: [
			'@evidence/core',
			/svelte/,
			'virtua',
			'echarts',
			'bits-ui',
			'runed'
		]
	},
	build: {
		rollupOptions: {
			// Only exists inside the compiled CLI binary (see cli/adapter/index.js's
			// generateDuckDBNativeAssetsModule, written after this vite build runs).
			// A bare specifier, not a relative path: duckdb.ts is bundled into this
			// SSR build too, and Rollup relocates it into a chunk at some arbitrary
			// depth — externalizing a *relative* id would have Rollup rewrite it
			// relative to the chunk's new location, which never matches where the
			// generated package actually ends up on disk. A bare id passes through
			// untouched, so real node_modules-style resolution (bun, at compile
			// time) finds the same package regardless of chunk depth.
			// duckdb.ts dynamic-imports it in a try/catch and falls back to normal
			// node_modules resolution when it's absent — true here, in dev, and in
			// the SvelteKit-server (non-compiled) build.
			external: (id) => id === 'duckdb-native-assets-generated'
		}
	}
});
