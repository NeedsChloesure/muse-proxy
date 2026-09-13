import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SELF } from 'cloudflare:test';

import { dav } from './dav';
import { adminJson, adminOk, signUp, url } from './helpers';

let cookie = '';

beforeAll(() => dav.install());
afterAll(() => dav.uninstall());

beforeEach(async () => {
	cookie = (await signUp('alice')).cookie;
	dav.reset();
	dav.discoveryDefaults();
});

/** The common case: same connection, a different server URL. */
function createWithBaseUrl(baseUrl: string) {
	return createConnection({ config: { baseUrl } });
}

function createConnection(overrides: Record<string, unknown> = {}) {
	return adminJson<{ data?: { connection: unknown; test: { ok: boolean; error?: string }; warnings: string[] }; error?: { code: string } }>(
		cookie,
		'/api/admin/connections',
		{
			method: 'POST',
			body: {
				provider: 'caldav',
				label: 'Personal',
				// Config is provider-owned and nested, so the core never learns what a
				// CalDAV connection needs.
				config: { baseUrl: 'https://dav.example.com/' },
				username: 'alice@example.com',
				secret: 'upstream-secret-pw',
				...overrides,
			},
		},
	);
}

/** Mint an agent key with grants, for asserting the agent-facing side of things. */
async function mintKey(
	cookie: string,
	name: string,
	grants: Array<{ connectionId: string; resourceKey: string; maxAccess: 'read' | 'write' }>,
): Promise<string> {
	const created = await adminOk<{ data: { token: string } }>(cookie, '/api/admin/keys', {
		method: 'POST',
		body: { name, grants },
	});
	return created.data.token;
}

describe('SSRF policy on connection creation', () => {
	it('refuses private and loopback addresses unless the deployment opts in', async () => {
		for (const baseUrl of ['https://192.168.1.10/', 'https://localhost:5232/', 'https://169.254.169.254/', 'https://10.0.0.1/']) {
			const { status, body } = await createWithBaseUrl(baseUrl);
			expect(status, baseUrl).toBe(400);
			expect(body.error?.code, baseUrl).toBe('blocked_host');
		}
	});

	it('refuses plain http, because credentials would travel in the clear', async () => {
		const { status, body } = await createWithBaseUrl('http://dav.example.com/');
		expect(status).toBe(400);
		expect(body.error?.code).toBe('insecure_base_url');
	});

	it('refuses malformed URLs, non-http schemes and embedded credentials', async () => {
		expect((await createWithBaseUrl('nonsense')).status).toBe(400);
		expect((await createWithBaseUrl('ftp://dav.example.com/')).status).toBe(400);
		expect((await createWithBaseUrl('https://user:pass@dav.example.com/')).status).toBe(400);
	});

	it('refuses an unknown provider', async () => {
		expect((await createConnection({ provider: 'imap' })).status).toBe(400);
	});
});

describe('provider-owned configuration', () => {
	it('validates a connection against the fields its provider declares', async () => {
		// A missing required field is named, rather than stored and discovered later.
		const missing = await createConnection({ config: {} });
		expect(missing.status).toBe(400);
		expect(missing.body.error?.code).toBe('invalid_request');

		const notAUrl = await createWithBaseUrl('nonsense');
		expect(notAUrl.status).toBe(400);
		// Caught by the declared field type before the SSRF policy is even consulted.
		expect(notAUrl.body.error?.message).toMatch(/must be a URL/i);
	});

	it('stores only declared fields, so config is a closed set', async () => {
		const { body } = await createConnection({
			config: { baseUrl: 'https://dav.example.com/', evil: 'smuggled', secretHint: 'attacker-controlled' },
		});
		const connection = body.data?.connection as { config: Record<string, unknown>; secretHint: string };

		expect(connection.config).toEqual({ baseUrl: 'https://dav.example.com/' });
		expect(JSON.stringify(body)).not.toContain('smuggled');
		// The hint is core metadata derived from the secret, never client-supplied.
		expect(connection.secretHint).toBe('••••t-pw');
	});

	it('returns the provider config and never the credential', async () => {
		const { body } = await createConnection();
		const connection = body.data?.connection as {
			config: Record<string, unknown>;
			username: string;
			authType: string;
			baseUrl?: string;
		};

		expect(connection.config.baseUrl).toBe('https://dav.example.com/');
		expect(connection.username).toBe('alice@example.com');
		expect(connection.authType).toBe('basic');
		// The core no longer has a notion of a base URL at the top level.
		expect(connection.baseUrl).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain('upstream-secret-pw');
	});

	it('publishes the declared fields so the console can render any provider', async () => {
		const meta = await adminJson<{ data: { providers: Array<{ type: string; fields: Array<{ name: string; required?: boolean }>; credentials: { usernameRequired: boolean } }> } }>(
			cookie,
			'/api/admin/meta',
		);
		const caldav = meta.body.data.providers.find((provider) => provider.type === 'caldav')!;

		expect(caldav.fields.map((field) => field.name)).toEqual(['baseUrl']);
		expect(caldav.fields[0].required).toBe(true);
		expect(caldav.credentials.usernameRequired).toBe(true);
	});

	it('re-validates config on update and marks the connection unverified', async () => {
		const created = await createConnection();
		const connection = created.body.data?.connection as { id: string };

		const bad = await adminJson(cookie, `/api/admin/connections/${connection.id}`, {
			method: 'PATCH',
			body: { config: { baseUrl: 'https://10.0.0.1/' } },
		});
		expect(bad.status).toBe(400);

		dav.seen.length = 0;
		const good = await adminOk<{ data: { connection: { config: Record<string, unknown>; status: string } } }>(
			cookie,
			`/api/admin/connections/${connection.id}`,
			{ method: 'PATCH', body: { config: { baseUrl: 'https://dav.example.com/other/' } } },
		);

		expect(good.data.connection.config.baseUrl).toBe('https://dav.example.com/other/');
		// A config change re-verifies against the NEW base, so the next PROPFIND
		// lands on /other/. The mock server only knows the default paths, so this
		// deliberately fails — which is exactly what proves the stored config is
		// what the provider dials.
		expect(dav.seen.map((request) => request.path)).toContain('/other/');
		expect(good.data.connection.status).toBe('error');
	});
});

describe('discovery', () => {
	it('verifies credentials, discovers collections, and enables none of them', async () => {
		const { status, body } = await createConnection();
		expect(status).toBe(200);
		expect(body.data?.test.ok).toBe(true);

		const connection = body.data?.connection as {
			status: string;
			resources: Array<{ resourceKey: string; kind: string; maxAccess: string }>;
		};
		expect(connection.status).toBe('ok');
		expect(connection.resources.map((resource) => resource.resourceKey).sort()).toEqual([
			'addressbooks/alice/people',
			'calendars/alice/home',
			'calendars/alice/work',
		]);

		const kinds = Object.fromEntries(connection.resources.map((resource) => [resource.resourceKey, resource.kind]));
		expect(kinds['calendars/alice/work']).toBe('calendar');
		expect(kinds['addressbooks/alice/people']).toBe('addressbook');

		// Deny by default: a new connection exposes nothing to anyone.
		expect(connection.resources.every((resource) => resource.maxAccess === 'none')).toBe(true);
	});

	it('injects the stored credentials upstream and never echoes them back', async () => {
		const { body } = await createConnection();

		expect(dav.seen.length).toBeGreaterThan(0);
		expect(dav.seen[0].authorization).toBe(`Basic ${btoa('alice@example.com:upstream-secret-pw')}`);
		expect(dav.seen.every((request) => request.authorization.startsWith('Basic '))).toBe(true);
		expect(dav.seen.map((request) => request.headers.depth)).toContain('0');

		const serialised = JSON.stringify(body);
		expect(serialised).not.toContain('upstream-secret-pw');
		expect(serialised).toContain('••••t-pw');
	});

	it('reports an auth failure without storing the connection as verified', async () => {
		dav.stub('PROPFIND', '/', { status: 401, body: 'denied' });

		const { status, body } = await createConnection({ label: 'Rejected' });
		expect(status).toBe(200);
		expect(body.data?.test.ok).toBe(false);
		expect(body.data?.test.error).toMatch(/rejected these credentials/i);

		const connection = body.data?.connection as { status: string; lastError: string };
		expect(connection.status).toBe('error');
		expect(connection.lastError).toMatch(/rejected these credentials/i);
	});

	it('reports an unreachable server rather than failing the request', async () => {
		// No interceptor exists for this origin, so the fetch rejects the way an
		// unreachable host would.
		const { status, body } = await createWithBaseUrl('https://unreachable.example.com/');
		expect(status).toBe(200);
		expect(body.data?.test.ok).toBe(false);
		expect(body.data?.test.error).toBeTruthy();
	});
});

describe('scoping collections', () => {
	it('persists an access change and records a notice for affected agents', async () => {
		const created = await createConnection();
		const connection = created.body.data?.connection as { id: string; resources: Array<{ id: string; resourceKey: string }> };
		const work = connection.resources.find((resource) => resource.resourceKey === 'calendars/alice/work')!;

		// The agent holds the collection before the ceiling changes, so the
		// emit-time fan-out reaches it.
		const token = await mintKey(cookie, 'notified agent', [
			{ connectionId: connection.id, resourceKey: 'calendars/alice/work', maxAccess: 'read' },
		]);

		const updated = await adminOk<{ data: { connection: { resources: Array<{ resourceKey: string; maxAccess: string }> } } }>(
			cookie,
			`/api/admin/connections/${connection.id}/resources/${work.id}`,
			{ method: 'PATCH', body: { maxAccess: 'read' } },
		);
		expect(updated.data.connection.resources.find((resource) => resource.resourceKey === 'calendars/alice/work')?.maxAccess).toBe('read');

		// The console surface for reading notices is gone (they are agent-only),
		// so assert the delivery itself through the agent endpoint.
		const listed = await SELF.fetch(url('/api/agent/notices'), { headers: { authorization: `Bearer ${token}` } });
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as { data: { notices: Array<{ kind: string; resourceKey: string | null }> } };
		expect(listedBody.data.notices.some((notice) => notice.resourceKey === 'calendars/alice/work')).toBe(true);
	});

	it('adds a collection by hand when a server reports incompletely', async () => {
		const created = await createConnection();
		const connection = created.body.data?.connection as { id: string };

		const updated = await adminOk<{
			data: { connection: { resources: Array<{ resourceKey: string; source: string; maxAccess: string }> } };
		}>(cookie, `/api/admin/connections/${connection.id}/resources`, {
			method: 'POST',
			body: { resourceKey: '/calendars/alice/manual/', displayName: 'Manual' },
		});

		const manual = updated.data.connection.resources.find((resource) => resource.resourceKey === 'calendars/alice/manual');
		expect(manual).toBeDefined();
		expect(manual?.source).toBe('manual');
		expect(manual?.maxAccess).toBe('none');
	});

	it('keeps a hand-added collection when discovery runs again', async () => {
		const created = await createConnection();
		const connection = created.body.data?.connection as { id: string };

		await adminOk(cookie, `/api/admin/connections/${connection.id}/resources`, {
			method: 'POST',
			body: { resourceKey: 'calendars/alice/manual' },
		});

		const rediscovered = await adminOk<{ data: { connection: { resources: Array<{ resourceKey: string }> } } }>(
			cookie,
			`/api/admin/connections/${connection.id}/discover`,
			{ method: 'POST' },
		);
		const keys = rediscovered.data.connection.resources.map((resource) => resource.resourceKey);
		expect(keys).toContain('calendars/alice/manual');
		expect(keys).toContain('calendars/alice/work');
	});

	it('rejects an access level that is not none/read/write', async () => {
		const created = await createConnection();
		const connection = created.body.data?.connection as { id: string; resources: Array<{ id: string }> };

		const { status } = await adminJson(cookie, `/api/admin/connections/${connection.id}/resources/${connection.resources[0].id}`, {
			method: 'PATCH',
			body: { maxAccess: 'admin' },
		});
		expect(status).toBe(400);
	});
});
