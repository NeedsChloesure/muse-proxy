import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { openApiDocument } from '../src/agent/router';
import { allProviders } from '../src/providers/registry';
import { url } from './helpers';

/**
 * Documentation drift is a failing test.
 *
 * The published specification is generated from the same declarations the
 * router uses, and every path it advertises must actually resolve — a 401 or a
 * 405 counts, a 404 does not. That is what makes "what is documented is what
 * this version supports" true rather than aspirational.
 */

function concretize(path: string): string {
	return path.replace(/\{[^}]+\}/g, 'placeholder');
}

describe('provider declarations', () => {
	it('registers exactly the providers that are documented and routable', () => {
		expect(allProviders().length).toBeGreaterThan(0);
		for (const provider of allProviders()) {
			expect(provider.docsPath, provider.type).toMatch(/^\/docs\//);
			expect(provider.openapiPath, provider.type).toBe(`/api/agent/${provider.type}/openapi.json`);
			expect(provider.summary.length, provider.type).toBeGreaterThan(10);
		}
	});
});

describe('every documented path resolves', () => {
	it('does not 404 any path in the aggregated specification', async () => {
		const document = openApiDocument() as { paths: Record<string, unknown> };
		const paths = Object.keys(document.paths);
		expect(paths.length).toBeGreaterThan(0);

		for (const path of paths) {
			const response = await SELF.fetch(url(concretize(path)));
			expect(response.status, `${path} (${concretize(path)}) returned 404`).not.toBe(404);
		}
	});

	it('does not 404 any path in a provider specification', async () => {
		for (const provider of allProviders()) {
			const response = await SELF.fetch(url(provider.openapiPath));
			expect(response.status, provider.openapiPath).toBe(200);

			const spec = (await response.json()) as { paths: Record<string, unknown> };
			for (const path of Object.keys(spec.paths)) {
				const probed = await SELF.fetch(url(concretize(path)));
				expect(probed.status, `${provider.type}: ${path}`).not.toBe(404);
			}
		}
	});
});

describe('every documented page is deployed', () => {
	it('serves each provider docs page', async () => {
		for (const provider of allProviders()) {
			const response = await SELF.fetch(url(provider.docsPath));
			expect(response.status, provider.docsPath).toBe(200);
			expect(response.headers.get('content-type'), provider.docsPath).toContain('text/html');
		}
	});

	it('serves the index and changelog the docs link to', async () => {
		for (const path of ['/docs/index.html', '/docs/changelog.html']) {
			expect((await SELF.fetch(url(path))).status, path).toBe(200);
		}
	});

	it('documents every provider in the catalog and in llms.txt', async () => {
		const response = await SELF.fetch(url('/api/agent'));
		const body = (await response.json()) as { data: { services: Array<{ type: string; docsUrl: string }> } };
		for (const provider of allProviders()) {
			const listed = body.data.services.find((service) => service.type === provider.type);
			expect(listed, provider.type).toBeDefined();
			expect(listed?.docsUrl).toBe(provider.docsPath);
		}

		const llms = await (await SELF.fetch(url('/llms.txt'))).text();
		for (const provider of allProviders()) {
			expect(llms, `llms.txt should mention ${provider.type}`).toContain(provider.type);
		}
	});
});
