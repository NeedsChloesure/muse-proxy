/**
 * The account's local Mail connection.
 *
 * Mail is a service this Worker hosts, not an upstream credential pair, so its
 * connection is created lazily instead of through the add-connection form. The
 * partial unique index in migration 0003 makes two concurrent first visits
 * harmless: the loser re-reads the winner's row.
 */

import * as repo from '../db/repo';
import type { Connection } from '../types';

export async function ensureMailConnection(env: Env, accountId: string): Promise<Connection> {
	const existing = await repo.getConnectionByProvider(env.DB, accountId, 'mail');
	if (existing) return existing;

	const id = crypto.randomUUID();
	const now = Date.now();
	try {
		await repo.createConnection(env.DB, {
			id,
			accountId,
			provider: 'mail',
			label: 'Mail',
			authType: 'none',
			username: null,
			// Local service: there is no upstream credential. Empty rather than a
			// fake secret, so nothing that resembles a password is ever stored.
			secretCiphertext: '',
			secretHint: 'local',
			configJson: '{}',
			now,
		});
	} catch (error) {
		const raced = await repo.getConnectionByProvider(env.DB, accountId, 'mail');
		if (raced) return raced;
		throw error;
	}

	await repo.updateConnection(env.DB, id, { status: 'ok', lastError: null }, now);
	const created = await repo.getConnection(env.DB, id);
	if (!created) throw new Error('Mail connection was inserted but could not be read back');
	return created;
}
