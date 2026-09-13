/**
 * Muse Proxy — an API-key gateway for services that normally require a
 * username and password.
 *
 * Routing contract. `assets.not_found_handling` is "single-page-application",
 * which rewrites ANY unmatched request to the root /index.html; the SPA shell is
 * therefore built to dist/index.html, with its bundle under dist/user/assets
 * (Vite `assetsDir`), and the landing page is rendered here instead of living in
 * the assets directory.
 *
 *   /                        landing (this file)
 *   /api/agent/<service>/*   provider-owned agent API — dispatched raw, because
 *                            providers accept arbitrary HTTP methods a
 *                            method-based router would not match
 *   /api/*                   admin + agent JSON API (Hono)
 *   /user/*                  SPA shell, with client-side route fallback
 *   /docs/*, /llms.txt       static assets
 *
 * `assets.run_worker_first` is `["/", "/api/*"]`, so static assets never invoke
 * the Worker and only unmatched paths reach the fallback at the bottom.
 */

import { Hono } from 'hono';

import { adminRoutes } from './admin/router';
import type { AppBindings } from './auth/middleware';
import { handleAgentRequest } from './agent/router';
import { renderLanding } from './landing';
import { problem, toErrorResponse } from './lib/http';

const AGENT_PREFIX = '/api/agent';

/**
 * The JSON API. The agent namespace is dispatched before this router because
 * providers accept arbitrary HTTP methods (PROPFIND, REPORT, MOVE) that a
 * method-keyed router would not match.
 */
const api = new Hono<AppBindings>();
api.onError((error) => toErrorResponse(error));
// An unknown /api path must return JSON, never the SPA shell.
api.notFound(() => problem(404, 'not_found', 'No such API endpoint.'));
api.route('/api/admin', adminRoutes);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === '/') return renderLanding(request);

			// Providers own this namespace outright and may use any method.
			if (path === AGENT_PREFIX || path.startsWith(AGENT_PREFIX + '/')) {
				return await handleAgentRequest(request, env, ctx);
			}

			if (path.startsWith('/api/')) {
				return await api.fetch(request, env, ctx);
			}

			const asset = await env.ASSETS.fetch(request);
			if (asset.status !== 404) return asset;

			// Client-side routes such as /user/keys/123 are not files, so fall
			// back to the SPA shell. Doing this here rather than relying on
			// not_found_handling keeps the behaviour identical whether or not the
			// platform's navigation shortcut applies.
			if (path === '/user' || path.startsWith('/user/')) return await serveSpaShell(request, env);

			return asset;
		} catch (error) {
			return toErrorResponse(error);
		}
	},
} satisfies ExportedHandler<Env>;

async function serveSpaShell(request: Request, env: Env): Promise<Response> {
	const shellUrl = new URL('/index.html', request.url).toString();
	const shell = await env.ASSETS.fetch(new Request(shellUrl, { method: 'GET', headers: { accept: 'text/html' } }));

	if (shell.status !== 200) {
		return problem(
			503,
			'frontend_missing',
			'The admin console has not been built into ./frontend/dist yet. Run `npm run build` before deploying.',
		);
	}

	const headers = new Headers(shell.headers);
	headers.set('content-type', 'text/html; charset=utf-8');
	// The shell is tiny and changes on every deploy; hashed assets are immutable.
	headers.set('cache-control', 'no-cache');
	return new Response(shell.body, { status: 200, headers });
}
