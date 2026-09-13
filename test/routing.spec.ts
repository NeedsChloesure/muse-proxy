import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { url } from './helpers';

/**
 * The hosting contract.
 *
 * assets.not_found_handling rewrites ANY unmatched request to the root
 * /index.html, so the SPA shell is built there and the landing page is rendered
 * by the Worker at "/". These tests pin that arrangement down.
 */

describe('the landing page at /', () => {
	it('serves plain text to something that does not ask for HTML', async () => {
		// curl sends Accept: */*, so an agent gets readable text by default.
		const response = await SELF.fetch(url('/'), { headers: { accept: '*/*' } });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/plain');

		const text = await response.text();
		expect(text).toContain('/user/');
		expect(text).toContain('/api/agent');
		expect(text).toContain('/docs/');
		expect(text).toContain('/llms.txt');
	});

	it('serves HTML when the client prefers HTML', async () => {
		const response = await SELF.fetch(url('/'), {
			headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
		});

		expect(response.headers.get('content-type')).toContain('text/html');
		const html = await response.text();
		expect(html).toContain('<html');
		expect(html).toContain('href="/user/"');
		expect(html).toContain('Muse Proxy');
	});

	it('advertises the API version and discovery links', async () => {
		const response = await SELF.fetch(url('/'), { headers: { accept: 'text/plain' } });
		expect(response.headers.get('X-Muse-Api-Version')).toBeTruthy();
		expect(response.headers.get('link')).toContain('/llms.txt');
	});
});

describe('SPA shell', () => {
	it('serves the shell for a deep client-side route', async () => {
		const response = await SELF.fetch(url('/user/keys/3'), { headers: { accept: 'text/html' } });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		const html = await response.text();
		expect(html).toContain('id="root"');
		// Assets are absolute under /user/, so the shell works from any route.
		expect(html).toContain('/user/assets/');
		// The shell must be revalidated so a deploy is picked up on the next load;
		// the platform sets this policy for asset-served HTML.
		expect(response.headers.get('cache-control')).toMatch(/no-cache|must-revalidate/);
	});

	it('serves the shell at /user/ itself', async () => {
		const response = await SELF.fetch(url('/user/'), { headers: { accept: 'text/html' } });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('id="root"');
	});
});

describe('API paths never fall through to HTML', () => {
	it('returns a JSON 404 for an unknown /api path', async () => {
		const response = await SELF.fetch(url('/api/admin/does-not-exist'));

		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toContain('application/json');
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe('not_found');
	});

	it('returns a JSON 404 for an unknown service on the agent API', async () => {
		const response = await SELF.fetch(url('/api/agent/imap/x'), { headers: { authorization: 'Bearer muse_whatever' } });

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { code: string; details: { services: string[] } } };
		expect(body.error.code).toBe('unknown_service');
		expect(body.error.details.services).toContain('caldav');
	});
});

describe('static assets', () => {
	it('serves the docs without invoking the API', async () => {
		for (const path of ['/docs/', '/docs/index.html', '/docs/changelog.html', '/llms.txt']) {
			const response = await SELF.fetch(url(path));
			expect(response.status, path).toBe(200);
		}
	});

	it('serves the hashed SPA bundle referenced by the shell', async () => {
		// Fetched through /user/ rather than /index.html: asset HTML handling
		// redirects the latter to /, which is the Worker-rendered landing page.
		const shell = await SELF.fetch(url('/user/'), { headers: { accept: 'text/html' } });
		const html = await shell.text();
		const asset = /\/user\/assets\/[^"']+\.js/.exec(html)?.[0];
		expect(asset).toBeTruthy();

		const response = await SELF.fetch(url(asset!));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('javascript');
	});
});
