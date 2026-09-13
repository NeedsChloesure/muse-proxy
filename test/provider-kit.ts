/**
 * The provider conformance kit.
 *
 * "Any service can be plugged in" is a claim until something enforces it. This
 * suite encodes the contract every provider must satisfy, so a new provider is
 * proven by passing it rather than by review: it appears in the catalog under
 * the shared mount convention, it cannot be reached across accounts, it cannot
 * exceed the two permission layers, it refuses in the standard shape, it keeps
 * the stored credential secret, and it validates its own config.
 *
 * A provider that cannot pass these tests is not a provider — it is a special
 * case that has leaked into the shared code.
 *
 * The harness supplies what only the provider knows: how to seed a usable
 * connection, what a valid config looks like, and one request that must be
 * refused. Everything else is the contract.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import * as repo from '../src/db/repo';
import type { ServiceProvider } from '../src/providers/types';
import { adminJson, adminOk, agentFetch, signUp, url } from './helpers';

export interface ProviderHarness {
	provider: ServiceProvider;
	/** Seed a fresh account, connection for this provider, and a granted key. */
	seed(): Promise<{ accountId: string; connectionId: string; token: string }>;
	/** A config object that would be valid for a new connection. */
	validConfig(): Record<string, unknown>;
	/** A credential pair the provider accepts. */
	credentials(): { username?: string; secret: string };
	/**
	 * A request this provider must refuse because the key's granted level is
	 * lower than the request needs. Refused before anything reaches upstream.
	 */
	denied(): { path: string; init: { method: string; headers?: Record<string, string>; body?: string } };
}

type Seed = Awaited<ReturnType<ProviderHarness['seed']>>;

/** A second account with a key that has no grants anywhere. */
async function outsider(): Promise<{ cookie: string; token: string }> {
	const { cookie } = await signUp(`bob-${crypto.randomUUID().slice(0, 8)}`);
	const created = await adminOk<{ data: { token: string } }>(cookie, '/api/admin/keys', {
		method: 'POST',
		body: { name: 'outsider' },
	});
	return { cookie, token: created.data.token };
}

export function providerConformance(harness: ProviderHarness): void {
	const { provider } = harness;
	const mount = `/api/agent/${provider.type}`;
	let seed: Seed;

	beforeEach(async () => {
		seed = await harness.seed();
	});

	describe(`${provider.type} · declared interface`, () => {
		it('is described to the console, fields and all', async () => {
			const response = await SELF.fetch(url('/api/admin/meta'));
			const body = (await response.json()) as {
				data: { providers: Array<{ type: string; fields: unknown; credentials: unknown; docsUrl: string }> };
			};
			const entry = body.data.providers.find((candidate) => candidate.type === provider.type);

			expect(entry).toBeDefined();
			// The console renders straight from these, so they must reach it.
			expect(entry?.fields).toEqual(provider.fields);
			expect(entry?.credentials).toEqual(provider.credentials);
			expect(entry?.docsUrl).toBe(provider.docsPath);
		});

		it('declares labelled config fields', () => {
			expect(provider.fields.length).toBeGreaterThan(0);
			for (const field of provider.fields) {
				expect(field.name, 'a field needs a name').toBeTruthy();
				expect(field.label, `${field.name} needs a label`).toBeTruthy();
			}
			expect(provider.credentials.usernameLabel).toBeTruthy();
			expect(provider.credentials.secretLabel).toBeTruthy();
		});

		it('refuses config it cannot use, instead of storing it', () => {
			if (provider.fields.some((field) => field.required)) {
				expect(() => provider.validateConfig({})).toThrow();
			}
			expect(() => provider.validateConfig('not an object')).toThrow();
		});

		it('stores only declared keys, so config is a closed set', async () => {
			const { cookie } = await signUp(`closed-${crypto.randomUUID().slice(0, 8)}`);
			const created = await adminOk<{ data: { connection: { config: Record<string, unknown> } } }>(
				cookie,
				'/api/admin/connections',
				{
					method: 'POST',
					body: {
						provider: provider.type,
						label: 'Closed set',
						config: { ...harness.validConfig(), undeclared: 'nope' },
						...harness.credentials(),
					},
				},
			);

			expect(created.data.connection.config).not.toHaveProperty('undeclared');
			expect(JSON.stringify(created.data.connection.config)).not.toContain('nope');
		});
	});

	describe(`${provider.type} · agent mount`, () => {
		it('is advertised in the catalog under the shared mount convention', async () => {
			const catalog = await SELF.fetch(url('/api/agent'), { headers: { authorization: `Bearer ${seed.token}` } });

			const body = (await catalog.json()) as {
				data: {
					services: Array<{ type: string; mount: string; docsUrl: string }>;
					connections: Array<{ id: string; mount: string }>;
				};
			};
			const service = body.data.services.find((entry) => entry.type === provider.type);
			expect(service?.mount).toBe(mount);
			expect(service?.docsUrl).toBe(provider.docsPath);

			// The router parses <connectionId> out of the path before dispatch, so a
			// provider's advertised connection mount must have that exact shape.
			const connection = body.data.connections.find((entry) => entry.id === seed.connectionId);
			expect(connection?.mount).toBe(`${mount}/${seed.connectionId}/`);
		});

		it('publishes an OpenAPI fragment scoped to its own namespace', async () => {
			const response = await SELF.fetch(url(`${mount}/openapi.json`));
			expect(response.status).toBe(200);

			const body = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
			expect(body.openapi).toBe('3.1.0');
			expect(Object.keys(body.paths).length).toBeGreaterThan(0);
			for (const path of Object.keys(body.paths)) {
				expect(path, 'a spec must not describe another service').toMatch(new RegExp(`^${mount}/`));
			}
		});

		it('404s a connection that does not exist', async () => {
			const response = await agentFetch(provider.type, 'does-not-exist', '/', seed.token);
			expect(response.status).toBe(404);
		});
	});

	describe(`${provider.type} · account isolation`, () => {
		it('hides another account’s connection behind a 404, not a 403', async () => {
			// A 403 would confirm the connection exists.
			const { token } = await outsider();
			const response = await agentFetch(provider.type, seed.connectionId, '/', token);
			expect(response.status).toBe(404);
		});

		it('hides another account’s connection from the console', async () => {
			const { cookie } = await outsider();
			const { status } = await adminJson(cookie, `/api/admin/connections/${seed.connectionId}`);
			expect(status).toBe(404);
		});

		it('refuses a connection belonging to a different service', async () => {
			// Stored directly: the point is the router's check, not another provider.
			const foreign = crypto.randomUUID();
			await repo.createConnection(env.DB, {
				id: foreign,
				accountId: seed.accountId,
				provider: 'not-a-real-provider',
				label: 'Foreign',
				authType: 'basic',
				username: 'alice',
				secretCiphertext: 'v1:x:y',
				secretHint: '••••',
				configJson: '{}',
				now: Date.now(),
			});

			const response = await agentFetch(provider.type, foreign, '/', seed.token);
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe('wrong_provider');
		});
	});

	describe(`${provider.type} · permission enforcement`, () => {
		it('refuses a key with no grant on the connection', async () => {
			const { cookie } = await signUp(`grantless-${crypto.randomUUID().slice(0, 8)}`);
			const created = await adminOk<{ data: { connection: { id: string } } }>(cookie, '/api/admin/connections', {
				method: 'POST',
				body: {
					provider: provider.type,
					label: 'Ungranted',
					config: harness.validConfig(),
					...harness.credentials(),
				},
			});
			const key = await adminOk<{ data: { token: string } }>(cookie, '/api/admin/keys', {
				method: 'POST',
				body: { name: 'no grants' },
			});

			const response = await agentFetch(provider.type, created.data.connection.id, '/', key.data.token);
			expect(response.status).toBe(403);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe('no_grant');
		});

		it('refuses with the standard guided 403 shape', async () => {
			const denied = harness.denied();
			const response = await agentFetch(provider.type, seed.connectionId, denied.path, seed.token, denied.init);

			expect(response.status).toBe(403);
			const body = (await response.json()) as {
				error: { code: string; details: { required: string; effective: string; permittedResources: string[]; reason: string } };
			};

			expect(body.error.code).toBe('insufficient_access');
			// Every refusal names the level needed, the level held, and what is
			// reachable instead — so a caller can correct itself.
			expect(body.error.details.required).toBe('write');
			expect(body.error.details.effective).toBe('read');
			expect(Array.isArray(body.error.details.permittedResources)).toBe(true);
			expect(body.error.details.reason).toBeTruthy();
		});

		it('requires a key before anything else', async () => {
			const response = await SELF.fetch(url(`${mount}/${seed.connectionId}/`), { method: 'GET' });
			expect(response.status).toBe(401);
		});
	});

	describe(`${provider.type} · credential secrecy`, () => {
		it('never returns the stored secret, only a masked hint', async () => {
			const { cookie } = await signUp(`secrecy-${crypto.randomUUID().slice(0, 8)}`);
			const { secret } = harness.credentials();
			const created = await adminOk<{ data: { connection: { secretHint: string } } }>(cookie, '/api/admin/connections', {
				method: 'POST',
				body: {
					provider: provider.type,
					label: 'Secrecy',
					config: harness.validConfig(),
					...harness.credentials(),
				},
			});

			expect(created.data.connection.secretHint).not.toContain(secret);
			expect(created.data.connection.secretHint).toContain('••••');

			// Reading it back must not leak it either.
			const listing = await adminOk<{ data: { connections: unknown[] } }>(cookie, '/api/admin/connections');
			expect(JSON.stringify(listing)).not.toContain(secret);
		});
	});
}
