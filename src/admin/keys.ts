/**
 * API key and grant management.
 *
 * A key's plaintext token is returned exactly once, at creation. Only its
 * SHA-256 is stored, so a database leak cannot be replayed as a working key.
 */

import { Hono } from 'hono';

import { requireSameOrigin, requireSession, type AppBindings, type AppContext } from '../auth/middleware';
import * as repo from '../db/repo';
import { emitNotice } from '../agent/notices';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, json } from '../lib/http';
import { asObject, optionalInt, optionalString, readJson, requiredArray, requiredOneOf, requiredString } from '../lib/validate';
import { accessForResource, type GrantEntry, type ScopeEntry } from '../lib/access';
import { ACCESS_RANK, KEY_PREFIX, type Access, type ApiKey, type ApiKeyGrant } from '../types';

export const keyRoutes = new Hono<AppBindings>();

keyRoutes.use('*', requireSession, requireSameOrigin);

interface GrantInput {
	connectionId: string;
	resourceKey: string;
	maxAccess: Exclude<Access, 'none'>;
}

keyRoutes.get('/', async (c) => {
	const accountId = c.get('session').account.id;
	const keys = await repo.listApiKeys(c.env.DB, accountId);
	const withGrants = [];
	for (const key of keys) {
		withGrants.push({ ...keyView(key), grants: await repo.listGrantsForKey(c.env.DB, key.id) });
	}
	return json({ ok: true, data: { keys: withGrants } });
});

keyRoutes.post('/', async (c) => {
	const accountId = c.get('session').account.id;
	const body = await readJson(c.req.raw);
	const db = c.env.DB;

	const name = requiredString(body, 'name', { max: 80 });
	const expiresInDays = optionalInt(body, 'expiresInDays', { min: 1, max: 3650 });
	const grants = await parseGrants(c, body.grants, accountId);

	const token = KEY_PREFIX + randomToken(32);
	const now = Date.now();
	const id = crypto.randomUUID();

	await repo.createApiKey(db, {
		id,
		accountId,
		name,
		prefix: token.slice(0, 12),
		tokenHash: await sha256Hex(token),
		createdAt: now,
		expiresAt: expiresInDays === undefined ? null : now + expiresInDays * 86_400_000,
	});

	if (grants.length > 0) await repo.replaceGrants(db, id, grants.map(withId));

	const key = (await repo.getApiKey(db, id))!;
	return json({
		ok: true,
		data: {
			key: keyView(key),
			grants: await repo.listGrantsForKey(db, id),
			// Shown once. It is not recoverable afterwards.
			token,
		},
	});
});

keyRoutes.get('/:id', async (c) => {
	const key = await owned(c);
	return json({
		ok: true,
		data: { key: keyView(key), grants: await repo.listGrantsForKey(c.env.DB, key.id) },
	});
});

keyRoutes.patch('/:id', async (c) => {
	const key = await owned(c);
	const body = await readJson(c.req.raw);

	const name = optionalString(body, 'name', { max: 80 });
	const expiresInDays = optionalInt(body, 'expiresInDays', { min: 0, max: 3650 });

	if (name !== undefined) await repo.updateApiKey(c.env.DB, key.id, { name });
	if (expiresInDays !== undefined) {
		await repo.updateApiKey(c.env.DB, key.id, {
			expiresAt: expiresInDays === 0 ? null : Date.now() + expiresInDays * 86_400_000,
		});
	}

	const refreshed = (await repo.getApiKey(c.env.DB, key.id))!;
	return json({ ok: true, data: { key: keyView(refreshed), grants: await repo.listGrantsForKey(c.env.DB, key.id) } });
});

/**
 * Delete is a true expunge: the row goes, and grants and any unread notices
 * cascade with it. Deleting is also the only way to stop a key immediately —
 * there is no revoke flag anymore — so the replacement workflow is delete,
 * then mint a fresh key with fresh grants. A key that expires on its own stays
 * listed as expired (with its last-used timestamp) until you delete it.
 */
keyRoutes.delete('/:id', async (c) => {
	const key = await owned(c);
	await repo.deleteApiKey(c.env.DB, key.id);
	return json({ ok: true, data: { deleted: key.id } });
});

keyRoutes.get('/:id/grants', async (c) => {
	const key = await owned(c);
	return json({ ok: true, data: { grants: await repo.listGrantsForKey(c.env.DB, key.id) } });
});

keyRoutes.put('/:id/grants', async (c) => {
	const key = await owned(c);
	const body = await readJson(c.req.raw);
	const db = c.env.DB;

	const before = await repo.listGrantsForKey(db, key.id);
	const grants = await parseGrants(c, body.grants, key.accountId);

	await repo.replaceGrants(db, key.id, grants.map(withId));

	await announceGrantChange(c, key, before, grants);
	return json({ ok: true, data: { grants: await repo.listGrantsForKey(db, key.id) } });
});

// -- helpers -----------------------------------------------------------------

async function owned(c: AppContext): Promise<ApiKey> {
	const accountId = c.get('session').account.id;
	const key = await repo.getApiKey(c.env.DB, c.req.param('id') ?? '');
	// Not-found and not-yours are deliberately the same response.
	if (!key || key.accountId !== accountId) throw new HttpError(404, 'not_found', 'No such API key.');
	return key;
}

function withId(grant: GrantInput): GrantInput & { id: string } {
	return { ...grant, id: crypto.randomUUID() };
}

function keyView(key: ApiKey) {
	return {
		id: key.id,
		name: key.name,
		prefix: key.prefix,
		createdAt: key.createdAt,
		expiresAt: key.expiresAt,
		lastUsedAt: key.lastUsedAt,
		active: key.expiresAt === null || key.expiresAt > Date.now(),
	};
}

/**
 * Validate a grant set: every connection must belong to the account, and every
 * named collection must exist on that connection. Granting a collection that
 * does not exist would silently do nothing, which is worse than an error.
 */
async function parseGrants(c: AppContext, raw: unknown, accountId: string): Promise<GrantInput[]> {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_request', "'grants' must be an array.");

	const entries = requiredArray({ grants: raw }, 'grants', 500);
	const connections = await repo.listConnections(c.env.DB, accountId);
	const byId = new Map(connections.map((connection) => [connection.id, connection]));

	const out: GrantInput[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		const grant = asObject(entry, 'grant');
		const connectionId = requiredString(grant, 'connectionId', { max: 60 });
		const connection = byId.get(connectionId);
		if (!connection) throw new HttpError(400, 'invalid_request', 'A grant references a connection that is not yours.');

		const rawResource = requiredString(grant, 'resourceKey', { max: 500 });
		const resourceKey = rawResource === '*' ? '*' : rawResource.replace(/^\/+/, '').replace(/\/+$/, '');
		if (resourceKey !== '*' && !(await repo.getResourceByKey(c.env.DB, connectionId, resourceKey))) {
			throw new HttpError(400, 'invalid_request', `'${resourceKey}' is not a collection on that connection.`);
		}

		const maxAccess = requiredOneOf(grant, 'maxAccess', ['read', 'write'] as const);
		const dedupe = `${connectionId}\u0000${resourceKey}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);

		out.push({ connectionId, resourceKey, maxAccess });
	}

	return out;
}

/**
 * Notify the key when its own reach changed. Widening is informational;
 * narrowing is a warning, because the agent may have tooling that now fails.
 */
async function announceGrantChange(c: AppContext, key: ApiKey, before: ApiKeyGrant[], after: GrantInput[]): Promise<void> {
	const connectionIds = [...new Set([...before.map((g) => g.connectionId), ...after.map((g) => g.connectionId)])];
	if (connectionIds.length === 0) return;

	const resources = await repo.listResourcesForConnections(c.env.DB, connectionIds);
	let tightened = false;
	let widened = false;

	for (const connectionId of connectionIds) {
		const scope: ScopeEntry[] = resources
			.filter((resource) => resource.connectionId === connectionId)
			.map((resource) => ({ resourceKey: resource.resourceKey, maxAccess: resource.maxAccess }));

		const toEntries = (
			grants: Array<{ connectionId: string; resourceKey: string; maxAccess: Exclude<Access, 'none'> }>,
		): GrantEntry[] =>
			grants
				.filter((grant) => grant.connectionId === connectionId)
				.map((grant) => ({ resourceKey: grant.resourceKey, maxAccess: grant.maxAccess }));

		const beforeEntries = toEntries(before);
		const afterEntries = toEntries(after);

		// Every collection could be affected by a wildcard change, so compare
		// across the union of mentioned keys and the connection's own scope.
		const candidates = new Set<string>([
			...scope.map((entry) => entry.resourceKey),
			...before.filter((grant) => grant.connectionId === connectionId).map((grant) => grant.resourceKey),
			...after.filter((grant) => grant.connectionId === connectionId).map((grant) => grant.resourceKey),
		]);
		candidates.delete('*');

		for (const candidate of candidates) {
			const beforeLevel = accessForResource(scope, beforeEntries, candidate);
			const afterLevel = accessForResource(scope, afterEntries, candidate);
			if (ACCESS_RANK[afterLevel] < ACCESS_RANK[beforeLevel]) tightened = true;
			if (ACCESS_RANK[afterLevel] > ACCESS_RANK[beforeLevel]) widened = true;
		}
	}

	if (!tightened && !widened) return;

	await emitNotice(
		c.env.DB,
		{
			accountId: key.accountId,
			kind: tightened ? 'grant_downgraded' : 'connection_updated',
			severity: tightened ? 'warning' : 'info',
			title: tightened ? `Your access was reduced for key '${key.name}'` : `Your access was widened for key '${key.name}'`,
			body: tightened
				? 'Some collections this key could reach are now read-only or unreachable. Requests that used to succeed may now be refused.'
				: 'This key can now reach more than before.',
			meta: { keyId: key.id },
		},
		{ kind: 'key', keyId: key.id },
	);
}
