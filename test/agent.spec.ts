import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { maybeEmitApiVersionNotice, resetApiVersionCheck, emitNotice } from '../src/agent/notices';
import * as repo from '../src/db/repo';
import { API_VERSION } from '../src/types';
import { seedGateway, url, type SeededGateway } from './helpers';

let seed: SeededGateway;

beforeEach(async () => {
	seed = await seedGateway();
});

function agentFetch(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<Response> {
	const headers: Record<string, string> = {};
	if (options.token) headers.authorization = `Bearer ${options.token}`;
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	return SELF.fetch(url(path), {
		method: options.method ?? 'GET',
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
}

describe('service catalog', () => {
	it('lists services without a key and no account data', async () => {
		const response = await agentFetch('/api/agent');
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			data: { services: Array<{ type: string; docsUrl: string }>; authenticated: boolean; connections?: unknown };
		};
		expect(body.data.authenticated).toBe(false);
		expect(body.data.services.map((service) => service.type)).toEqual(['caldav']);
		expect(body.data.services[0].docsUrl).toBe('/docs/agent/caldav.html');
		expect(body.data.connections).toBeUndefined();
	});

	it('reports the reachable collections and their effective access with a key', async () => {
		const response = await agentFetch('/api/agent', { token: seed.token });
		const body = (await response.json()) as {
			data: {
				authenticated: boolean;
				key: { prefix: string };
				connections: Array<{
					id: string;
					label: string;
					mount: string;
					wildcard: boolean;
					resources: Array<{ resourceKey: string; access: string; kind: string }>;
				}>;
			};
		};

		expect(body.data.authenticated).toBe(true);
		expect(body.data.key.prefix).toBe(seed.token.slice(0, 12));

		expect(body.data.connections).toHaveLength(1);
		const connection = body.data.connections[0];
		expect(connection.mount).toBe(`/api/agent/caldav/${seed.connectionId}/`);
		expect(connection.wildcard).toBe(false);

		const byKey = Object.fromEntries(connection.resources.map((resource) => [resource.resourceKey, resource.access]));
		// The key asked for write on both; the connection ceiling caps one at read.
		expect(byKey['calendars/alice/work']).toBe('read');
		expect(byKey['addressbooks/alice/people']).toBe('write');
	});

	it('omits connections the key has no grant on', async () => {
		await repo.createConnection(env.DB, {
			id: 'conn-unrelated',
			accountId: seed.accountId,
			provider: 'caldav',
			label: 'Unrelated',
			authType: 'basic',
			username: 'alice',
			secretCiphertext: 'v1:x:y',
			secretHint: '••••',
			configJson: JSON.stringify({ baseUrl: 'https://other.example.com/' }),
			now: Date.now(),
		});

		const response = await agentFetch('/api/agent', { token: seed.token });
		const body = (await response.json()) as { data: { connections: Array<{ id: string }> } };
		expect(body.data.connections.map((connection) => connection.id)).toEqual([seed.connectionId]);
	});

	it('publishes an OpenAPI document covering the provider routes', async () => {
		const response = await agentFetch('/api/agent/openapi.json');
		expect(response.status).toBe(200);
		const body = (await response.json()) as { openapi: string; info: { version: string }; paths: Record<string, unknown> };
		expect(body.openapi).toBe('3.1.0');
		expect(body.info.version).toBe(API_VERSION);
		expect(Object.keys(body.paths)).toContain('/api/agent/caldav/{connectionId}/{path}');
		expect(Object.keys(body.paths)).toContain('/api/agent/notices');
	});
});

describe('notices', () => {
	it('signals a pending notice on ordinary responses, including proxied ones', async () => {
		await emitNotice(
			env.DB,
			{
				accountId: seed.accountId,
				kind: 'grant_downgraded',
				severity: 'warning',
				title: 'Access to Work was reduced to read',
				body: 'The connection owner lowered the ceiling.',
				connectionId: seed.connectionId,
				resourceKey: 'calendars/alice/work',
			},
			{ kind: 'connection', connectionId: seed.connectionId, resourceKey: 'calendars/alice/work' },
		);

		// A JSON endpoint carries it in the body...
		const catalog = await agentFetch('/api/agent', { token: seed.token });
		const catalogBody = (await catalog.json()) as { notices: Array<{ kind: string }> };
		expect(catalogBody.notices.map((notice) => notice.kind)).toContain('grant_downgraded');

		// ...and a proxied DAV response signals it in headers, since its body is upstream XML.
		const gateway = await agentFetch(`/api/agent/caldav/${seed.connectionId}/calendars/alice/work/`, {
			token: seed.token,
			method: 'OPTIONS',
		});
		expect(gateway.headers.get('X-Muse-Notices')).toBe('1');
		expect(gateway.headers.get('X-Muse-Notices-Url')).toBe('/api/agent/notices');
	});

	it('lists, then acknowledges notices', async () => {
		await emitNotice(
			env.DB,
			{
				accountId: seed.accountId,
				kind: 'credentials_changed',
				title: 'Credentials changed',
				body: 'Re-verified.',
				connectionId: seed.connectionId,
			},
			{ kind: 'connection', connectionId: seed.connectionId },
		);

		const pending = await agentFetch('/api/agent/notices', { token: seed.token });
		const pendingBody = (await pending.json()) as { data: { pending: number; notices: Array<{ id: string }> } };
		expect(pendingBody.data.pending).toBe(1);

		const ack = await agentFetch('/api/agent/notices/ack', {
			token: seed.token,
			method: 'POST',
			body: { ids: [pendingBody.data.notices[0].id] },
		});
		const ackBody = (await ack.json()) as { data: { acknowledged: number; pending: number } };
		expect(ackBody.data.acknowledged).toBe(1);
		expect(ackBody.data.pending).toBe(0);

		const after = await agentFetch('/api/agent/notices', { token: seed.token });
		expect(((await after.json()) as { data: { pending: number } }).data.pending).toBe(0);
	});

	it('delivers only to the keys whose grants are affected', async () => {
		// A key on an unrelated connection must not receive it.
		await repo.createApiKey(env.DB, {
			id: 'key-other',
			accountId: seed.accountId,
			name: 'other',
			prefix: 'muse_other',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});

		await emitNotice(
			env.DB,
			{
				accountId: seed.accountId,
				kind: 'grant_downgraded',
				title: 'Work was reduced',
				body: 'x',
				connectionId: seed.connectionId,
				resourceKey: 'calendars/alice/work',
			},
			{ kind: 'connection', connectionId: seed.connectionId, resourceKey: 'calendars/alice/work' },
		);

		expect(await repo.countPendingNoticesForKey(env.DB, 'key-1')).toBe(1);
		expect(await repo.countPendingNoticesForKey(env.DB, 'key-other')).toBe(0);
	});

	it('rejects an unknown notice id on acknowledge without failing the call', async () => {
		const response = await agentFetch('/api/agent/notices/ack', {
			token: seed.token,
			method: 'POST',
			body: { ids: ['not-a-notice'] },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { data: { acknowledged: number } }).data.acknowledged).toBe(1);
	});
});

describe('api version notices', () => {
	it('announces a version change once per deployment', async () => {
		await repo.setSetting(env.DB, 'notified_api_version', '2000-01-01', Date.now());
		resetApiVersionCheck();

		await maybeEmitApiVersionNotice(env);
		expect(await repo.countPendingNoticesForKey(env.DB, 'key-1')).toBe(1);

		const notices = await repo.listPendingAgentNotices(env.DB, 'key-1');
		expect(notices[0].kind).toBe('api_version_updated');
		expect(notices[0].metaJson).toContain('/docs/changelog.html');

		// The setting is updated, so it is not repeated.
		expect(await repo.getSetting(env.DB, 'notified_api_version')).toBe(API_VERSION);
	});

	it('does not announce anything when the version is unchanged', async () => {
		await repo.setSetting(env.DB, 'notified_api_version', API_VERSION, Date.now());
		resetApiVersionCheck();

		await maybeEmitApiVersionNotice(env);
		expect(await repo.countPendingNoticesForKey(env.DB, 'key-1')).toBe(0);
	});
});
