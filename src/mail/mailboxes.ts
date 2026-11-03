/**
 * Mailbox lifecycle.
 *
 * Creating a mailbox also creates its connection resource in the same batch:
 * the resource is what grants and the key scope matrix point at, so a mailbox
 * without one would receive mail no agent could ever be granted. Deleting a
 * mailbox removes both (see deleteMailbox in db.ts).
 */

import { HttpError } from '../lib/http';
import { getMailboxForAccount, trimMailbox, type MailboxRow, type Overflow } from './db';
import { isValidAddress, newId, normalizeAddress, nowIso, splitAddress } from './lib';

export interface NewMailboxInput {
	accountId: string;
	connectionId: string;
	address: string;
	displayName?: string | null;
	quotaBytes?: number;
	quotaMessages?: number;
	overflow?: Overflow;
	retentionDays?: number;
}

export function resolveAddressInput(raw: string, defaultDomain: string): string {
	let address = normalizeAddress(raw);
	if (!address.includes('@') && defaultDomain) address = `${address}@${defaultDomain}`;
	if (!isValidAddress(address)) {
		throw new HttpError(422, 'invalid_address', 'Provide a full address like notes@mail.example.com.');
	}
	return address;
}

export async function createMailbox(env: Env, input: NewMailboxInput): Promise<MailboxRow> {
	const address = normalizeAddress(input.address);
	const parts = splitAddress(address);
	const id = newId('mbx', 12);
	const resourceId = crypto.randomUUID();
	const timestamp = nowIso();
	const displayName = input.displayName ?? null;

	try {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO connection_resources (
				   id, connection_id, resource_key, kind, display_name, max_access, meta_json, discovered_at
				 ) VALUES (?, ?, ?, 'mailbox', ?, 'none', ?, ?)`,
			).bind(resourceId, input.connectionId, address, displayName ?? address, '{"source":"manual"}', Date.now()),
			env.DB.prepare(
				`INSERT INTO mailboxes (
				   id, account_id, connection_id, address, local_part, domain, display_name, enabled,
				   quota_bytes, quota_messages, overflow, retention_days,
				   used_bytes, used_messages, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?)`,
			).bind(
				id,
				input.accountId,
				input.connectionId,
				address,
				parts.localPart,
				parts.domain,
				displayName,
				input.quotaBytes ?? 0,
				input.quotaMessages ?? 0,
				input.overflow ?? 'trim_oldest',
				input.retentionDays ?? 0,
				timestamp,
				timestamp,
			),
		]);
	} catch (error) {
		if (/unique/i.test(String(error))) {
			throw new HttpError(409, 'mailbox_exists', `A mailbox already exists for ${address}.`);
		}
		throw error;
	}

	const row = await getMailboxForAccount(env, input.accountId, address);
	if (!row) throw new Error('Mailbox was inserted but could not be read back');
	return row;
}

export interface MailboxChanges {
	displayName?: string | null;
	enabled?: boolean;
	quotaBytes?: number;
	quotaMessages?: number;
	overflow?: Overflow;
	retentionDays?: number;
}

export async function applyMailboxChanges(
	env: Env,
	mailbox: MailboxRow,
	changes: MailboxChanges,
): Promise<MailboxRow> {
	const sets: string[] = [];
	const values: unknown[] = [];

	if (changes.displayName !== undefined) {
		sets.push('display_name = ?');
		values.push(changes.displayName);
	}
	if (changes.enabled !== undefined) {
		sets.push('enabled = ?');
		values.push(changes.enabled ? 1 : 0);
	}
	if (changes.quotaBytes !== undefined) {
		sets.push('quota_bytes = ?');
		values.push(changes.quotaBytes);
	}
	if (changes.quotaMessages !== undefined) {
		sets.push('quota_messages = ?');
		values.push(changes.quotaMessages);
	}
	if (changes.retentionDays !== undefined) {
		sets.push('retention_days = ?');
		values.push(changes.retentionDays);
	}
	if (changes.overflow !== undefined) {
		sets.push('overflow = ?');
		values.push(changes.overflow);
	}
	if (sets.length === 0) return mailbox;

	sets.push('updated_at = ?');
	values.push(nowIso());
	values.push(mailbox.id);

	const statements = [env.DB.prepare(`UPDATE mailboxes SET ${sets.join(', ')} WHERE id = ?`).bind(...values)];
	if (changes.displayName !== undefined) {
		statements.push(
			env.DB.prepare('UPDATE connection_resources SET display_name = ? WHERE connection_id = ? AND resource_key = ?').bind(
				changes.displayName ?? mailbox.address,
				mailbox.connection_id,
				mailbox.address,
			),
		);
	}
	await env.DB.batch(statements);

	const updated = await getMailboxForAccount(env, mailbox.account_id, mailbox.address);
	if (!updated) throw new HttpError(404, 'mailbox_not_found', 'Mailbox disappeared while updating.');

	const quotaChanged =
		changes.quotaBytes !== undefined || changes.quotaMessages !== undefined || changes.overflow !== undefined;
	if (quotaChanged && updated.overflow === 'trim_oldest') await trimMailbox(env, updated.id);
	return (await getMailboxForAccount(env, mailbox.account_id, mailbox.address)) ?? updated;
}
