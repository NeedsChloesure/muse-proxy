import { env, SELF } from 'cloudflare:test';

import { encryptSecret, sha256Hex } from '../src/lib/crypto';
import * as repo from '../src/db/repo';

export const ORIGIN = 'https://muse.test';
export const DAV = 'https://dav.example.com';

export function url(path: string): string {
	return ORIGIN + path;
}

export function cookieFrom(response: Response): string {
	const header = response.headers.get('set-cookie');
	if (!header) throw new Error('expected a Set-Cookie header');
	return header.split(';')[0];
}

export async function signUp(username = 'alice', password = 'password12345'): Promise<{ cookie: string; accountId: string }> {
	const response = await SELF.fetch(url('/api/admin/auth/signup'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	if (!response.ok) throw new Error(`signup failed: ${response.status} ${await response.text()}`);

	const payload = (await response.json()) as { data: { account: { id: string } } };
	return { cookie: cookieFrom(response), accountId: payload.data.account.id };
}

export async function adminJson<T>(
	cookie: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
	const response = await SELF.fetch(url(path), {
		method: init.method ?? 'GET',
		headers: {
			cookie,
			...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const text = await response.text();
	return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Convenience for the common case of asserting a successful admin call. */
export async function adminOk<T>(cookie: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	const { status, body } = await adminJson<T>(cookie, path, init);
	if (status >= 400) throw new Error(`expected success from ${path}, got ${status}: ${JSON.stringify(body)}`);
	return body;
}

// -- DAV fixtures ------------------------------------------------------------

export function davResponse(href: string, inner: string): string {
	return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${inner}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

export function multistatus(...responses: string[]): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav">' +
		responses.join('') +
		'</D:multistatus>'
	);
}

export const CALENDAR_TYPE = '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>';
export const ADDRESSBOOK_TYPE = '<D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype>';
export const PRINCIPAL = (href: string) => `<D:current-user-principal><D:href>${href}</D:href></D:current-user-principal>`;
export const CALENDAR_HOME = (href: string) => `<C:calendar-home-set><D:href>${href}</D:href></C:calendar-home-set>`;
export const ADDRESSBOOK_HOME = (href: string) => `<CR:addressbook-home-set><D:href>${href}</D:href></CR:addressbook-home-set>`;
export const DISPLAY_NAME = (name: string) => `<D:displayname>${name}</D:displayname>`;

export function normalizeHeaders(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) return out;
	if (Array.isArray(raw)) {
		for (let i = 0; i < raw.length; i += 2) out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
		return out;
	}
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		out[name.toLowerCase()] = String(value);
	}
	return out;
}

// -- gateway seeding ---------------------------------------------------------

export interface SeededGateway {
	accountId: string;
	connectionId: string;
	token: string;
}

/**
 * Seed a connection whose collections have DIFFERENT ceilings, and a key whose
 * grants ask for more than one of them allows. That asymmetry is what proves the
 * gateway intersects the two layers rather than trusting either.
 *
 *   calendars/alice/work        connection: read    key grant: write  -> effective read
 *   addressbooks/alice/people   connection: write   key grant: write  -> effective write
 */
export async function seedGateway(): Promise<SeededGateway> {
	const accountId = crypto.randomUUID();
	await repo.createAccount(env.DB, {
		id: accountId,
		username: 'alice',
		passwordHash: 'unused-in-this-test',
		isAdmin: true,
		createdAt: Date.now(),
	});

	const connectionId = crypto.randomUUID();
	await repo.createConnection(env.DB, {
		id: connectionId,
		accountId,
		provider: 'caldav',
		label: 'Personal',
		authType: 'basic',
		username: 'alice@example.com',
		secretCiphertext: await encryptSecret('s3cret-upstream-password', env),
		secretHint: '••••word',
		// Provider-owned config: the core stores it without interpreting it.
		configJson: JSON.stringify({ baseUrl: `${DAV}/` }),
		now: Date.now(),
	});

	const now = Date.now();
	await repo.upsertResource(env.DB, {
		id: 'res-work',
		connectionId,
		resourceKey: 'calendars/alice/work',
		kind: 'calendar',
		displayName: 'Work',
		metaJson: '{"source":"discovered"}',
		now,
	});
	await repo.upsertResource(env.DB, {
		id: 'res-people',
		connectionId,
		resourceKey: 'addressbooks/alice/people',
		kind: 'addressbook',
		displayName: 'People',
		metaJson: '{"source":"discovered"}',
		now,
	});
	await repo.setResourceAccess(env.DB, 'res-work', 'read');
	await repo.setResourceAccess(env.DB, 'res-people', 'write');

	const token = 'muse_' + 'k'.repeat(40);
	await repo.createApiKey(env.DB, {
		id: 'key-1',
		accountId,
		name: 'calendar agent',
		prefix: token.slice(0, 12),
		tokenHash: await sha256Hex(token),
		createdAt: now,
		expiresAt: null,
	});
	await repo.replaceGrants(env.DB, 'key-1', [
		{ id: 'grant-work', connectionId, resourceKey: 'calendars/alice/work', maxAccess: 'write' },
		{ id: 'grant-people', connectionId, resourceKey: 'addressbooks/alice/people', maxAccess: 'write' },
	]);

	return { accountId, connectionId, token };
}

/**
 * A request to any provider's agent mount.
 *
 * Providers own their URL space but share this convention: the connection id
 * comes first, then the provider's own path. The router relies on it, so the
 * conformance kit can too.
 */
export function agentFetch(
	providerType: string,
	connectionId: string,
	path: string,
	token: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
	return SELF.fetch(url(`/api/agent/${providerType}/${connectionId}${path}`), {
		method: init.method ?? 'GET',
		headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
		body: init.body,
		// The gateway rewrites upstream redirects into its own namespace and hands
		// them back; without this the test fetch would silently follow them and
		// hide both the status and the rewritten Location.
		redirect: 'manual',
	});
}

export function gatewayFetch(
	connectionId: string,
	path: string,
	token: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
	return agentFetch('caldav', connectionId, path, token, init);
}
