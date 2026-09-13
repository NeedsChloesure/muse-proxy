import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { emitNotice, maybeEmitApiVersionNotice, resetApiVersionCheck } from '../src/agent/notices';
import { sha256Hex } from '../src/lib/crypto';
import * as repo from '../src/db/repo';
import { API_VERSION } from '../src/types';
import { adminOk, signUp, url } from './helpers';

/**
 * Notices are for the AGENT, not the human: each row in `agent_notices` is
 * addressed to one key, and acknowledging deletes it. There is deliberately no
 * account-wide master copy and no catch-up pass — delivery is computed at emit
 * time from the grants that exist at that instant, so a notice never reaches a
 * key that could not already have acted on it, and storage is bounded by what
 * agents have not read.
 */

/** An account with one connection, two collections and no keys. */
async function accountWithConnection(username: string): Promise<{
	cookie: string;
	accountId: string;
	connectionId: string;
}> {
	const { cookie, accountId } = await signUp(username);
	const connectionId = `conn-${username}`;
	await repo.createConnection(env.DB, {
		id: connectionId,
		accountId,
		provider: 'caldav',
		label: 'Personal',
		authType: 'basic',
		username: `${username}@example.com`,
		secretCiphertext: 'v1:x:y',
		secretHint: '••••word',
		configJson: JSON.stringify({ baseUrl: 'https://dav.example.com/' }),
		now: Date.now(),
	});
	for (const resourceKey of ['calendars/alice/work', 'calendars/alice/private']) {
		await repo.upsertResource(env.DB, {
			id: `${connectionId}-${resourceKey}`,
			connectionId,
			resourceKey,
			kind: 'calendar',
			displayName: resourceKey,
			metaJson: '{"source":"discovered"}',
			now: Date.now(),
		});
		await repo.setResourceAccess(env.DB, `${connectionId}-${resourceKey}`, 'write');
	}
	return { cookie, accountId, connectionId };
}

async function mintKey(
	cookie: string,
	name: string,
	grants: Array<{ connectionId: string; resourceKey: string; maxAccess: 'read' | 'write' }> = [],
): Promise<{ keyId: string; token: string }> {
	const created = await adminOk<{ data: { key: { id: string }; token: string } }>(cookie, '/api/admin/keys', {
		method: 'POST',
		body: { name, grants },
	});
	return { keyId: created.data.key.id, token: created.data.token };
}

async function pendingKinds(keyId: string): Promise<string[]> {
	return (await repo.listPendingAgentNotices(env.DB, keyId)).map((notice) => notice.kind);
}

describe('emit-time delivery targeting', () => {
	it('delivers a connection-scoped notice only to keys holding a grant on it', async () => {
		const { accountId, connectionId } = await accountWithConnection('carol');
		const otherId = 'conn-carol-other';
		await repo.createConnection(env.DB, {
			id: otherId,
			accountId,
			provider: 'caldav',
			label: 'Work',
			authType: 'basic',
			username: 'carol@example.com',
			secretCiphertext: 'v1:x:y',
			secretHint: '••••word',
			configJson: JSON.stringify({ baseUrl: 'https://other.example.com/' }),
			now: Date.now(),
		});
		await repo.createApiKey(env.DB, {
			id: 'carol-key',
			accountId,
			name: 'calendar agent',
			prefix: 'muse_carol',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});
		await repo.replaceGrants(env.DB, 'carol-key', [
			{ id: 'carol-grant', connectionId, resourceKey: 'calendars/alice/work', maxAccess: 'read' },
		]);

		await emitNotice(
			env.DB,
			{
				accountId,
				kind: 'credentials_changed',
				title: "Credentials for 'Work' were changed",
				body: 'The stored credentials were replaced.',
				connectionId: otherId,
			},
			{ kind: 'connection', connectionId: otherId },
		);

		// The key has no grant on the affected connection, so it is not told.
		expect(await pendingKinds('carol-key')).not.toContain('credentials_changed');

		await emitNotice(
			env.DB,
			{
				accountId,
				kind: 'credentials_changed',
				title: "Credentials for 'Personal' were changed",
				body: 'The stored credentials were replaced.',
				connectionId,
			},
			{ kind: 'connection', connectionId },
		);
		expect(await pendingKinds('carol-key')).toContain('credentials_changed');
	});

	it('delivers a collection-scoped notice to a key holding the wildcard', async () => {
		const { accountId, connectionId } = await accountWithConnection('frank');

		await repo.createApiKey(env.DB, {
			id: 'frank-key',
			accountId,
			name: 'wildcard agent',
			prefix: 'muse_frank',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});
		await repo.replaceGrants(env.DB, 'frank-key', [
			{ id: 'frank-grant', connectionId, resourceKey: '*', maxAccess: 'read' },
		]);

		await emitNotice(
			env.DB,
			{
				accountId,
				kind: 'grant_downgraded',
				title: "Access to 'Work' was reduced to read",
				body: 'The connection owner reduced this collection.',
				connectionId,
				resourceKey: 'calendars/alice/work',
			},
			{ kind: 'connection', connectionId, resourceKey: 'calendars/alice/work' },
		);
		expect(await pendingKinds('frank-key')).toContain('grant_downgraded');
	});

	it('narrowing a notice to a collection excludes keys granted only another collection', async () => {
		const { accountId, connectionId } = await accountWithConnection('grace');

		await repo.createApiKey(env.DB, {
			id: 'grace-key',
			accountId,
			name: 'narrow agent',
			prefix: 'muse_grace',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});
		await repo.replaceGrants(env.DB, 'grace-key', [
			{ id: 'grace-grant', connectionId, resourceKey: 'calendars/alice/private', maxAccess: 'read' },
		]);

		await emitNotice(
			env.DB,
			{
				accountId,
				kind: 'resource_removed',
				title: "Collection 'Work' was removed",
				body: 'x',
				connectionId,
				resourceKey: 'calendars/alice/work',
			},
			{ kind: 'connection', connectionId, resourceKey: 'calendars/alice/work' },
		);
		expect(await pendingKinds('grace-key')).not.toContain('resource_removed');
	});

	it('skips expired keys, whose owners cannot read anything anyway', async () => {
		const { accountId, connectionId } = await accountWithConnection('henry');

		await repo.createApiKey(env.DB, {
			id: 'henry-dead',
			accountId,
			name: 'expired agent',
			prefix: 'muse_henry',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});
		await repo.updateApiKey(env.DB, 'henry-dead', { expiresAt: Date.now() - 1 });

		await emitNotice(
			env.DB,
			{
				accountId,
				kind: 'connection_deleted',
				title: "Connection 'Personal' was deleted",
				body: 'x',
				connectionId: null,
			},
			{ kind: 'connection', connectionId },
		);
		expect(await pendingKinds('henry-dead')).toHaveLength(0);
	});

	it('acknowledging a notice deletes the rows', async () => {
		const { accountId, connectionId } = await accountWithConnection('iris');

		await repo.createApiKey(env.DB, {
			id: 'iris-key',
			accountId,
			name: 'calendar agent',
			prefix: 'muse_iris',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});
		await repo.replaceGrants(env.DB, 'iris-key', [
			{ id: 'iris-grant', connectionId, resourceKey: 'calendars/alice/work', maxAccess: 'read' },
		]);

		await emitNotice(
			env.DB,
			{
				accountId,
				kind: 'grant_downgraded',
				title: "Access to 'Work' was reduced to read",
				body: 'x',
				connectionId,
				resourceKey: 'calendars/alice/work',
			},
			{ kind: 'connection', connectionId, resourceKey: 'calendars/alice/work' },
		);
		const pending = await repo.listPendingAgentNotices(env.DB, 'iris-key');
		expect(pending).toHaveLength(1);

		await repo.deleteAgentNotices(
			env.DB,
			'iris-key',
			pending.map((notice) => notice.id),
		);
		// Deletion is the ack: nothing is kept to be resurrected by a later
		// catch-up, because there is no catch-up.
		expect(await repo.countPendingNoticesForKey(env.DB, 'iris-key')).toBe(0);
	});
});

describe('api version notices', () => {
	it('fan out to every active key on the account', async () => {
		const { accountId } = await accountWithConnection('judy');
	const token = crypto.randomUUID().replace(/-/g, '');
	await repo.createApiKey(env.DB, {
		id: 'judy-key',
		accountId,
		name: 'agent',
		prefix: 'muse_judy',
		tokenHash: await sha256Hex(token),
		createdAt: Date.now(),
		expiresAt: null,
	});
		await repo.createApiKey(env.DB, {
			id: 'judy-dead',
			accountId,
			name: 'expired agent',
			prefix: 'muse_judy2',
			tokenHash: 'unused',
			createdAt: Date.now(),
			expiresAt: null,
		});
	await repo.updateApiKey(env.DB, 'judy-dead', { expiresAt: Date.now() - 1 });

	await repo.setSetting(env.DB, 'notified_api_version', '2000-01-01', Date.now());
	resetApiVersionCheck();
	await maybeEmitApiVersionNotice(env);

	expect(await pendingKinds('judy-key')).toContain('api_version_updated');
	expect(await pendingKinds('judy-dead')).toHaveLength(0);

	// The setting is updated, so it is not repeated.
	expect(await repo.getSetting(env.DB, 'notified_api_version')).toBe(API_VERSION);
});
});
