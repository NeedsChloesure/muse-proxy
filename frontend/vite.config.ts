import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA is served from /user/.
 *
 * Two hosting facts shape this config:
 *
 *  1. assets.not_found_handling rewrites ANY unmatched request to the root
 *     /index.html, so the shell must be built there. That is what makes deep
 *     links like /user/keys/3 work without a Worker invocation.
 *  2. Static asset URLs are resolved as `base + path relative to outDir`, so a
 *     `base` of '/user/' would require the bundle to live in dist/user/assets
 *     and then be rewritten to /user/user/assets. Instead assetsDir carries the
 *     /user/ prefix and `base` stays '/'.
 *
 * Net result: dist/index.html is the shell, and it references
 * /user/assets/* — URLs that map exactly onto files under dist/user/assets.
 * The SPA's own routes use a router basename of /user; `base` only affects how
 * built asset URLs are written.
 */
export default defineConfig({
	base: '/',
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			'/api': 'http://localhost:8787',
		},
	},
	build: {
		outDir: 'dist',
		assetsDir: 'user/assets',
		emptyOutDir: true,
	},
});
