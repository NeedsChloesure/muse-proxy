/**
 * Connection management.
 *
 * A connection is a stored upstream credential plus its per-collection ACL.
 * Nothing here ever returns the secret: responses carry a masked hint only, and
 * the ciphertext never leaves the Worker.
 */

import { Hono } from 'hono';

import { requireSameOrigin, requireSession, type AppBindings, type AppContext } from '../auth/middleware';
import * as repo from '../db/repo';
import { emitNotice } from '../agent/notices';
import { decryptSecret, encryptSecret, secretHint } from '../lib/crypto';
import { HttpError, json } from '../lib/http';
import { toResourceKey } from '../lib/url';
import { optionalOneOf, optionalString, readJson, requiredOneOf, requiredString } from '../lib/validate';
import { SUPPORTED_AUTH_TYPES } from '../lib/upstream-auth';
import { ACCESS_RANK, type Access, type Connection, type ConnectionResource } from '../types';
import { getProvider, providerTypes } from '../providers/registry';
import type { AdminProviderCtx, DiscoveredResource, ProviderCredentials, ServiceProvider } from '../providers/types';

export const connectionRoutes = new Hono<AppBindings>();

connectionRoutes.use('*', requireSession, requireSameOrigin);

connectionRoutes.get('/', async (c) => {
	const accountId = c.get('session').account.id;
	const connections = await repo.listConnections(c.env.DB, accountId);
	const views = [];
	for (const connection of connections) views.push(await view(c.env, connection));
	return json({ ok: true, data: { connections: views } });
});

connectionRoutes.post('/', async (c) => {
	const body = await readJson(c.req.raw);
	const accountId = c.get('session').account.id;
	const db = c.env.DB;

	const providerType = requiredOneOf(body, 'provider', providerTypes());
	const provider = requireProvider(providerType);

	const label = requiredString(body, 'label', { max: 80 });
	// Config is provider-owned and declaratively validated, so a connection can
	// only ever carry the fields its provider declared.
	const config = provider.validateConfig(body.config);
	const credentials = readCredentials(provider, body);
	const authType = validateAuthType(provider, body.authType, provider.defaultAuthType);

	// Enforce the provider's dial policy (SSRF, TLS) before anything is stored.
	provider.verifyConfig(config, c.env);

	const id = crypto.randomUUID();
	await repo.createConnection(db, {
		id,
		accountId,
		provider: providerType,
		label,
		authType,
		username: credentials.username,
		secretCiphertext: await encryptSecret(credentials.secret, c.env),
		secretHint: secretHint(credentials.secret),
		configJson: JSON.stringify(config),
		now: Date.now(),
	});

	// Verify and discover immediately, so the connection comes back usable.
	const test = await provider.test({ env: c.env, connectionId: id, config, credentials, authType });
	const warnings: string[] = [];
	let resources: DiscoveredResource[] = [];

	if (test.ok) {
		try {
			resources = await provider.discover({ env: c.env, connectionId: id, config, credentials, authType });
		} catch (error) {
			warnings.push(message(error, 'Discovery failed.'));
		}
	}
	await repo.updateConnection(db, id, { status: test.ok ? 'ok' : 'error', lastError: test.ok ? null : test.error }, Date.now());

	if (resources.length > 0) {
		await persistDiscovered(db, id, resources);
		await emitNotice(
			db,
			{
				accountId,
				kind: 'service_added',
				title: `Service '${label}' connected`,
				body: `${resources.length} collection(s) were discovered. None are reachable by any key until you grant access to them.`,
				connectionId: id,
			},
			{ kind: 'account' },
		);
	}

	const connection = await repo.getConnection(db, id);
	return json({ ok: true, data: { connection: connection ? await view(c.env, connection) : null, test, warnings } });
});

connectionRoutes.get('/:id', async (c) => {
	const connection = await owned(c);
	return json({ ok: true, data: { connection: await view(c.env, connection) } });
});

connectionRoutes.patch('/:id', async (c) => {
	const connection = await owned(c);
	const provider = requireProvider(connection.provider);
	const body = await readJson(c.req.raw);
	const db = c.env.DB;

	const label = optionalString(body, 'label', { max: 80 });
	// An explicitly empty username clears it. `optionalString` cannot express
	// that — it reports '' as "not supplied" — so the field's presence decides,
	// and the two intentions become `null` (clear) and a non-empty string (set).
	const username =
		body.username === undefined ? undefined : optionalString(body, 'username', { max: 200 }) ?? null;
	const authType = body.authType === undefined ? undefined : validateAuthType(provider, body.authType, provider.defaultAuthType);
	const secret = optionalString(body, 'secret', { min: 1, max: 500, trim: false });
	const configTouched = body.config !== undefined;
	const config = configTouched ? provider.validateConfig(body.config) : parseJson(connection.configJson);

	if (configTouched) provider.verifyConfig(config, c.env);

	const changes: Parameters<typeof repo.updateConnection>[2] = {};
	if (label !== undefined) changes.label = label;
	if (username !== undefined) changes.username = username;
	if (configTouched) changes.configJson = JSON.stringify(config);
	if (authType !== undefined) changes.authType = authType;
	if (secret !== undefined) {
		changes.secretCiphertext = await encryptSecret(secret, c.env);
		changes.secretHint = secretHint(secret);
	}

	// Anything that changes what the provider dials or authenticates with
	// invalidates the previous verification.
	const recheck = secret !== undefined || username !== undefined || authType !== undefined || configTouched;
	if (recheck) {
		changes.status = 'unverified';
		changes.lastError = null;
	}
	await repo.updateConnection(db, connection.id, changes, Date.now());

	if (recheck) {
		const refreshed = (await repo.getConnection(db, connection.id))!;
		const test = await provider.test(await providerCtx(c.env, refreshed, config));
		await repo.updateConnection(db, refreshed.id, { status: test.ok ? 'ok' : 'error', lastError: test.ok ? null : test.error }, Date.now());

		await emitNotice(
			db,
			{
				accountId: connection.accountId,
				kind: 'credentials_changed',
				severity: test.ok ? 'info' : 'warning',
				title: `Credentials for '${refreshed.label}' were changed`,
				body: test.ok
					? 'The stored credentials were replaced and verified against the server.'
					: `The stored credentials were replaced, but verification failed: ${test.error}`,
				connectionId: connection.id,
			},
			{ kind: 'connection', connectionId: connection.id },
		);
	}

	const final = (await repo.getConnection(db, connection.id))!;
	return json({ ok: true, data: { connection: await view(c.env, final) } });
});

connectionRoutes.delete('/:id', async (c) => {
	const connection = await owned(c);
	const db = c.env.DB;

	// Fan out while the grants still exist, but keep the notice row itself free
	// of the connection so it is not cascaded away with it.
	await emitNotice(
		db,
		{
			accountId: connection.accountId,
			kind: 'connection_deleted',
			severity: 'warning',
			title: `Connection '${connection.label}' was deleted`,
			body: 'The connection and its stored credentials were removed. Keys that referenced it can no longer reach it.',
			connectionId: null,
		},
		{ kind: 'connection', connectionId: connection.id },
	);

	await repo.deleteConnection(db, connection.id);
	return json({ ok: true, data: { deleted: connection.id } });
});

connectionRoutes.post('/:id/test', async (c) => {
	const connection = await owned(c);
	const provider = requireProvider(connection.provider);

	const test = await provider.test(await providerCtx(c.env, connection, parseJson(connection.configJson)));

	await repo.updateConnection(c.env.DB, connection.id, { status: test.ok ? 'ok' : 'error', lastError: test.ok ? null : test.error }, Date.now());
	const refreshed = (await repo.getConnection(c.env.DB, connection.id))!;
	return json({ ok: true, data: { test, connection: await view(c.env, refreshed) } });
});

connectionRoutes.post('/:id/discover', async (c) => {
	const connection = await owned(c);
	const provider = requireProvider(connection.provider);
	const config = parseJson(connection.configJson);

	let resources: DiscoveredResource[];
	try {
		resources = await provider.discover(await providerCtx(c.env, connection, config));
	} catch (error) {
		if (error instanceof HttpError) {
			await repo.updateConnection(c.env.DB, connection.id, { status: 'error', lastError: error.message }, Date.now());
		}
		throw error;
	}

	await persistDiscovered(c.env.DB, connection.id, resources);
	await repo.updateConnection(c.env.DB, connection.id, { status: 'ok', lastError: null }, Date.now());

	const refreshed = (await repo.getConnection(c.env.DB, connection.id))!;
	return json({ ok: true, data: { connection: await view(c.env, refreshed) } });
});

/** Add a collection by hand, for servers whose discovery is incomplete. */
connectionRoutes.post('/:id/resources', async (c) => {
	const connection = await owned(c);
	const body = await readJson(c.req.raw);

	const resourceKey = toResourceKey(requiredString(body, 'resourceKey', { max: 500 }));
	if (!resourceKey) throw new HttpError(400, 'invalid_request', "'resourceKey' must name a collection path.");

	const kind = optionalString(body, 'kind', { max: 40 }) ?? 'calendar';
	const displayName = optionalString(body, 'displayName', { max: 120 }) ?? resourceKey;
	const maxAccess = optionalOneOf(body, 'maxAccess', ['none', 'read', 'write'] as const);

	// The row's id is known before the write — upsert keeps an existing row's id
	// and a new one is generated here — so setting its access needs no second
	// read to find it again.
	const existing = await repo.getResourceByKey(c.env.DB, connection.id, resourceKey);
	const resourceId = existing?.id ?? crypto.randomUUID();
	await repo.upsertResource(c.env.DB, {
		id: resourceId,
		connectionId: connection.id,
		resourceKey,
		kind,
		displayName,
		// Marked manual so a later discovery run will not prune it.
		metaJson: JSON.stringify({ source: 'manual' }),
		now: Date.now(),
	});

	if (maxAccess && maxAccess !== 'none') {
		await repo.setResourceAccess(c.env.DB, resourceId, maxAccess);
	}

	const refreshed = (await repo.getConnection(c.env.DB, connection.id))!;
	return json({ ok: true, data: { connection: await view(c.env, refreshed) } });
});

connectionRoutes.patch('/:id/resources/:resourceId', async (c) => {
	const connection = await owned(c);
	const body = await readJson(c.req.raw);
	const maxAccess = requiredOneOf(body, 'maxAccess', ['none', 'read', 'write'] as const);

	const resource = await repo.getResource(c.env.DB, c.req.param('resourceId'));
	if (!resource || resource.connectionId !== connection.id) {
		throw new HttpError(404, 'not_found', 'No such collection on this connection.');
	}

	await repo.setResourceAccess(c.env.DB, resource.id, maxAccess);
	await announceScopeChange(c, connection, resource, maxAccess);

	const refreshed = (await repo.getConnection(c.env.DB, connection.id))!;
	return json({ ok: true, data: { connection: await view(c.env, refreshed) } });
});

connectionRoutes.delete('/:id/resources/:resourceId', async (c) => {
	const connection = await owned(c);
	const resource = await repo.getResource(c.env.DB, c.req.param('resourceId'));
	if (!resource || resource.connectionId !== connection.id) {
		throw new HttpError(404, 'not_found', 'No such collection on this connection.');
	}

	await emitNotice(
		c.env.DB,
		{
			accountId: connection.accountId,
			kind: 'resource_removed',
			severity: 'warning',
			title: `Collection '${resource.displayName ?? resource.resourceKey}' was removed`,
			body: 'It is no longer part of this connection, so keys that referenced it cannot reach it.',
			connectionId: connection.id,
			resourceKey: resource.resourceKey,
		},
		{ kind: 'connection', connectionId: connection.id, resourceKey: resource.resourceKey },
	);

	await repo.deleteResources(c.env.DB, [resource.id]);
	const refreshed = (await repo.getConnection(c.env.DB, connection.id))!;
	return json({ ok: true, data: { connection: await view(c.env, refreshed) } });
});

// -- helpers -----------------------------------------------------------------

function requireProvider(type: string): ServiceProvider {
	const provider = getProvider(type);
	if (!provider) throw new HttpError(500, 'unknown_provider', `The provider '${type}' is no longer available.`);
	return provider;
}

/** Validate an authentication type before it can be persisted. */
function validateAuthType(provider: ServiceProvider, value: unknown, fallback: string): string {
	const raw = value === undefined || value === null || value === '' ? fallback : value;
	if (typeof raw !== 'string') {
		throw new HttpError(400, 'invalid_request', "'authType' must be a string.", { field: 'authType' });
	}
	const normalized = raw.trim().toLowerCase();
	const allowed = provider.authTypes.length > 0 ? provider.authTypes : SUPPORTED_AUTH_TYPES;
	if (!normalized || !allowed.includes(normalized)) {
		throw new HttpError(400, 'invalid_request', `'authType' must be one of: ${allowed.join(', ')}.`, { field: 'authType' });
	}
	return normalized;
}

/**
 * Read the credential pair from a create request. The provider declares whether
 * it needs a username, so a token-only provider is not forced to invent one.
 */
function readCredentials(provider: ServiceProvider, body: Record<string, unknown>): ProviderCredentials {
	const username = optionalString(body, 'username', { max: 200 }) ?? null;
	if (provider.credentials.usernameRequired && !username) {
		throw new HttpError(400, 'invalid_request', `'username' is required for ${provider.displayName}.`, { field: 'username' });
	}
	const secret = requiredString(body, 'secret', { min: 1, max: 500, trim: false });
	return { username, secret };
}

/** Build the admin-side provider context for a stored connection. */
async function providerCtx(env: Env, connection: Connection, config: Record<string, unknown>): Promise<AdminProviderCtx> {
	return {
		env,
		connectionId: connection.id,
		config,
		credentials: { username: connection.username, secret: await decryptSecret(connection.secretCiphertext, env) },
		authType: connection.authType,
	};
}

async function owned(c: AppContext): Promise<Connection> {
	const accountId = c.get('session').account.id;
	const connection = await repo.getConnectionForAccount(c.env.DB, c.req.param('id') ?? '', accountId);
	if (!connection) throw new HttpError(404, 'not_found', 'No such connection.');
	return connection;
}

function parseJson(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function isDiscovered(metaJson: string): boolean {
	return parseJson(metaJson).source === 'discovered';
}

async function persistDiscovered(db: D1Database, connectionId: string, resources: DiscoveredResource[]): Promise<void> {
	const existing = await repo.listResources(db, connectionId);
	const byKey = new Map(existing.map((resource) => [resource.resourceKey, resource]));
	const seen = new Set<string>();
	const now = Date.now();

	for (const resource of resources) {
		seen.add(resource.resourceKey);
		await repo.upsertResource(db, {
			id: byKey.get(resource.resourceKey)?.id ?? crypto.randomUUID(),
			connectionId,
			resourceKey: resource.resourceKey,
			kind: resource.kind,
			displayName: resource.displayName,
			metaJson: JSON.stringify(resource.meta ?? { source: 'discovered' }),
			now,
		});
	}

	// Prune only what discovery itself introduced, so hand-added collections
	// survive a server that reports incompletely.
	const stale = existing.filter((resource) => !seen.has(resource.resourceKey) && isDiscovered(resource.metaJson));
	await repo.deleteResources(db, stale.map((resource) => resource.id));
}

/**
 * Tell the agents whose keys cover this collection that its ceiling moved.
 * Only affected keys receive it, which is why the fan-out lives in SQL.
 */
async function announceScopeChange(c: AppContext, connection: Connection, resource: ConnectionResource, after: Access): Promise<void> {
	const before = resource.maxAccess;
	if (before === after) return;

	const tightened = ACCESS_RANK[after] < ACCESS_RANK[before];
	const name = resource.displayName ?? resource.resourceKey;

	await emitNotice(
		c.env.DB,
		{
			accountId: connection.accountId,
			kind: tightened ? 'grant_downgraded' : 'connection_updated',
			severity: tightened ? 'warning' : 'info',
			title: tightened ? `Access to '${name}' was reduced to ${after}` : `Access to '${name}' is now ${after}`,
			body: tightened
				? `The connection owner reduced this collection's ceiling from ${before} to ${after}. Keys granted more than that are now limited to ${after}.`
				: `The connection owner raised this collection's ceiling from ${before} to ${after}. Keys are still limited by their own grants.`,
			connectionId: connection.id,
			resourceKey: resource.resourceKey,
		},
		{ kind: 'connection', connectionId: connection.id, resourceKey: resource.resourceKey },
	);
}

interface ConnectionView {
	id: string;
	provider: string;
	label: string;
	username: string | null;
	authType: string;
	/** Provider-owned; the console renders it from the provider's declared fields. */
	config: Record<string, unknown>;
	status: string;
	lastError: string | null;
	secretHint: string;
	createdAt: number;
	updatedAt: number;
	resources: Array<{
		id: string;
		resourceKey: string;
		kind: string;
		displayName: string | null;
		maxAccess: Access;
		source: string;
	}>;
}

/** Serialise a connection for the frontend. The secret is never included. */
export async function view(env: Env, connection: Connection): Promise<ConnectionView> {
	const resources = await repo.listResources(env.DB, connection.id);
	return {
		id: connection.id,
		provider: connection.provider,
		label: connection.label,
		username: connection.username,
		authType: connection.authType,
		config: parseJson(connection.configJson),
		status: connection.status,
		lastError: connection.lastError,
		secretHint: connection.secretHint,
		createdAt: connection.createdAt,
		updatedAt: connection.updatedAt,
		resources: resources.map((resource) => ({
			id: resource.id,
			resourceKey: resource.resourceKey,
			kind: resource.kind,
			displayName: resource.displayName,
			maxAccess: resource.maxAccess,
			source: (parseJson(resource.metaJson).source as string) ?? 'discovered',
		})),
	};
}
