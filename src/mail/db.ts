/**
 * Mail persistence.
 *
 * A mailbox belongs to exactly one account and to that account's single 'mail'
 * connection. Messages and attachments hang off the mailbox, so every query
 * that serves an authenticated caller can be scoped by joining mailboxes —
 * which is what keeps one account's mail out of another's reach even if a
 * message id leaks.
 */

import { chunk, escapeLike, nowIso, type Cursor } from './lib';

export type Overflow = 'trim_oldest' | 'reject_new';

export interface MailboxRow {
	id: string;
	account_id: string;
	connection_id: string;
	address: string;
	local_part: string;
	domain: string;
	display_name: string | null;
	enabled: number;
	quota_bytes: number;
	quota_messages: number;
	overflow: Overflow;
	retention_days: number;
	used_bytes: number;
	used_messages: number;
	created_at: string;
	updated_at: string;
}

export interface MailboxWithLast extends MailboxRow {
	last_received_at: string | null;
}

export interface MessageRow {
	id: string;
	mailbox_id: string;
	source_hash: string;
	message_id: string | null;
	in_reply_to: string | null;
	references_header: string | null;
	envelope_from: string | null;
	envelope_to: string | null;
	from_addr: string | null;
	from_name: string | null;
	to_json: string | null;
	cc_json: string | null;
	reply_to_json: string | null;
	subject: string | null;
	received_at: string;
	sent_at: string | null;
	size_bytes: number;
	stored_bytes: number;
	attachment_count: number;
	has_attachments: number;
	is_read: number;
	is_starred: number;
	preview: string | null;
	text_body: string | null;
	html_body: string | null;
	body_truncated: number;
	raw_storage: string | null;
	raw_data: unknown;
	raw_key: string | null;
	headers_json: string | null;
	parse_error: string | null;
	created_at: string;
}

export interface MessageWithAddress extends MessageRow {
	mailbox_address: string;
	mailbox_connection_id: string;
}

/** Summary columns for list pages; deliberately excludes bodies and raw BLOBs. */
export type MessageListRow = Omit<
	MessageRow,
	'source_hash' | 'text_body' | 'html_body' | 'body_truncated' | 'raw_data' | 'headers_json' | 'created_at'
>;

export interface AttachmentRow {
	id: string;
	message_id: string;
	filename: string | null;
	mime_type: string;
	size_bytes: number;
	content_id: string | null;
	disposition: string | null;
	is_inline: number;
	storage: 'd1' | 'kv' | 'unavailable';
	data: unknown;
	kv_key: string | null;
	sha256: string | null;
	created_at: string;
}

export interface AttachmentWithAddress extends AttachmentRow {
	mailbox_id: string;
	mailbox_address: string;
	mailbox_connection_id: string;
}

export interface MailboxStats {
	messages: number;
	unread: number;
	bytes: number;
	oldest_at: string | null;
	newest_at: string | null;
	attachments: { storage: string; count: number; bytes: number }[];
}

export interface MessageQuery {
	mailboxId: string;
	limit: number;
	offset?: number;
	cursor?: Cursor | null;
	order?: 'asc' | 'desc';
	since?: string | null;
	before?: string | null;
	unread?: boolean;
	starred?: boolean;
	hasAttachments?: boolean;
	search?: string | null;
}

export async function getMailboxByAddress(env: Env, address: string): Promise<MailboxRow | null> {
	return env.DB.prepare('SELECT * FROM mailboxes WHERE address = ?').bind(address).first<MailboxRow>();
}

export async function getMailboxForAccount(env: Env, accountId: string, address: string): Promise<MailboxRow | null> {
	return env.DB.prepare('SELECT * FROM mailboxes WHERE account_id = ? AND address = ?')
		.bind(accountId, address)
		.first<MailboxRow>();
}

export async function getMailboxForConnection(
	env: Env,
	accountId: string,
	connectionId: string,
	address: string,
): Promise<MailboxRow | null> {
	return env.DB.prepare('SELECT * FROM mailboxes WHERE account_id = ? AND connection_id = ? AND address = ?')
		.bind(accountId, connectionId, address)
		.first<MailboxRow>();
}

export async function listMailboxes(env: Env, accountId: string, connectionId?: string): Promise<MailboxWithLast[]> {
	const where = connectionId ? 'WHERE mb.account_id = ? AND mb.connection_id = ?' : 'WHERE mb.account_id = ?';
	const statement = env.DB.prepare(
		`SELECT mb.*, (SELECT MAX(received_at) FROM messages m WHERE m.mailbox_id = mb.id) AS last_received_at
		 FROM mailboxes mb ${where}
		 ORDER BY mb.address ASC`,
	);
	const bound = connectionId ? statement.bind(accountId, connectionId) : statement.bind(accountId);
	const result = await bound.all<MailboxWithLast>();
	return result.results;
}

/** Discovery needs every mailbox on a connection without knowing its account. */
export async function listMailboxesForConnection(env: Env, connectionId: string): Promise<MailboxRow[]> {
	const result = await env.DB.prepare('SELECT * FROM mailboxes WHERE connection_id = ? ORDER BY address ASC')
		.bind(connectionId)
		.all<MailboxRow>();
	return result.results;
}

export function mailboxRecalcStatement(env: Env, mailboxId: string, updatedAt = nowIso()): D1PreparedStatement {
	return env.DB.prepare(
		`UPDATE mailboxes SET
		   used_bytes = COALESCE((SELECT SUM(stored_bytes) FROM messages WHERE mailbox_id = ?), 0),
		   used_messages = (SELECT COUNT(*) FROM messages WHERE mailbox_id = ?),
		   updated_at = ?
		 WHERE id = ?`,
	).bind(mailboxId, mailboxId, updatedAt, mailboxId);
}

export async function recalcMailbox(env: Env, mailboxId: string): Promise<void> {
	await mailboxRecalcStatement(env, mailboxId).run();
}

export async function mailboxStats(env: Env, mailboxId: string): Promise<MailboxStats> {
	const totals = await env.DB.prepare(
		`SELECT COUNT(*) AS messages,
		        COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
		        COALESCE(SUM(stored_bytes), 0) AS bytes,
		        MIN(received_at) AS oldest_at,
		        MAX(received_at) AS newest_at
		 FROM messages WHERE mailbox_id = ?`,
	)
		.bind(mailboxId)
		.first<Omit<MailboxStats, 'attachments'>>();

	const attachments = await env.DB.prepare(
		`SELECT a.storage AS storage, COUNT(*) AS count, COALESCE(SUM(a.size_bytes), 0) AS bytes
		 FROM attachments a
		 JOIN messages m ON m.id = a.message_id
		 WHERE m.mailbox_id = ?
		 GROUP BY a.storage`,
	)
		.bind(mailboxId)
		.all<{ storage: string; count: number; bytes: number }>();

	return {
		messages: totals?.messages ?? 0,
		unread: totals?.unread ?? 0,
		bytes: totals?.bytes ?? 0,
		oldest_at: totals?.oldest_at ?? null,
		newest_at: totals?.newest_at ?? null,
		attachments: attachments.results,
	};
}

export async function getMessageForAccount(env: Env, accountId: string, id: string): Promise<MessageWithAddress | null> {
	return env.DB.prepare(
		`SELECT m.*, mb.address AS mailbox_address, mb.connection_id AS mailbox_connection_id
		 FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
		 WHERE m.id = ? AND mb.account_id = ?`,
	)
		.bind(id, accountId)
		.first<MessageWithAddress>();
}

export async function listAttachments(env: Env, messageId: string): Promise<AttachmentRow[]> {
	const result = await env.DB.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid ASC')
		.bind(messageId)
		.all<AttachmentRow>();
	return result.results;
}

export async function getAttachmentForAccount(
	env: Env,
	accountId: string,
	id: string,
): Promise<AttachmentWithAddress | null> {
	return env.DB.prepare(
		`SELECT a.*, m.mailbox_id AS mailbox_id, mb.address AS mailbox_address,
		        mb.connection_id AS mailbox_connection_id
		 FROM attachments a
		 JOIN messages m ON m.id = a.message_id
		 JOIN mailboxes mb ON mb.id = m.mailbox_id
		 WHERE a.id = ? AND mb.account_id = ?`,
	)
		.bind(id, accountId)
		.first<AttachmentWithAddress>();
}

function messageFilters(query: MessageQuery): { sql: string; params: unknown[] } {
	const clauses: string[] = ['mailbox_id = ?'];
	const params: unknown[] = [query.mailboxId];

	if (query.since) {
		clauses.push('received_at >= ?');
		params.push(query.since);
	}
	if (query.before) {
		clauses.push('received_at < ?');
		params.push(query.before);
	}
	if (query.unread) clauses.push('is_read = 0');
	if (query.starred) clauses.push('is_starred = 1');
	if (query.hasAttachments) clauses.push('has_attachments = 1');
	if (query.search) {
		const like = `%${escapeLike(query.search)}%`;
		clauses.push(
			`(subject LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\')`,
		);
		params.push(like, like, like, like, like);
	}
	return { sql: clauses.join(' AND '), params };
}

export async function listMessages(
	env: Env,
	query: MessageQuery,
): Promise<{ rows: MessageListRow[]; hasMore: boolean }> {
	const { sql: where, params } = messageFilters(query);
	const order = query.order === 'asc' ? 'ASC' : 'DESC';
	const values = [...params];

	let keyset = '';
	if (query.cursor) {
		const comparison = order === 'ASC' ? '>' : '<';
		keyset = ` AND (received_at ${comparison} ? OR (received_at = ? AND id ${comparison} ?))`;
		values.push(query.cursor.receivedAt, query.cursor.receivedAt, query.cursor.id);
	}

	values.push(query.limit + 1);
	if (query.offset) values.push(query.offset);

	const result = await env.DB.prepare(
		`SELECT id, mailbox_id, message_id, in_reply_to, references_header,
		        envelope_from, envelope_to, from_addr, from_name, to_json, cc_json, reply_to_json,
		        subject, received_at, sent_at, size_bytes, stored_bytes, attachment_count,
		        has_attachments, is_read, is_starred, preview, raw_storage, raw_key, parse_error
		 FROM messages WHERE ${where}${keyset}
		 ORDER BY received_at ${order}, id ${order}
		 LIMIT ?${query.offset ? ' OFFSET ?' : ''}`,
	)
		.bind(...values)
		.all<MessageListRow>();

	const rows = result.results.slice(0, query.limit);
	return { rows, hasMore: result.results.length > query.limit };
}

export async function countMessages(
	env: Env,
	query: Omit<MessageQuery, 'limit' | 'cursor' | 'offset' | 'order'>,
): Promise<number> {
	const { sql: where, params } = messageFilters({ ...query, limit: 1 });
	const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`)
		.bind(...params)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function kvKeysForMessageIds(env: Env, ids: string[]): Promise<{ mailboxIds: Set<string>; keys: string[] }> {
	const mailboxIds = new Set<string>();
	const keys: string[] = [];
	for (const idsChunk of chunk(ids, 50)) {
		const placeholders = idsChunk.map(() => '?').join(',');
		const messages = await env.DB.prepare(
			`SELECT id, mailbox_id, raw_key FROM messages WHERE id IN (${placeholders})`,
		)
			.bind(...idsChunk)
			.all<{ id: string; mailbox_id: string; raw_key: string | null }>();
		for (const row of messages.results) {
			mailboxIds.add(row.mailbox_id);
			if (row.raw_key) keys.push(row.raw_key);
		}
		const attachments = await env.DB.prepare(
			`SELECT kv_key FROM attachments WHERE message_id IN (${placeholders}) AND kv_key IS NOT NULL`,
		)
			.bind(...idsChunk)
			.all<{ kv_key: string }>();
		for (const row of attachments.results) keys.push(row.kv_key);
	}
	return { mailboxIds, keys };
}

/** Delete messages and their KV payloads, then repair each affected mailbox's counters. */
export async function deleteMessagesByIds(env: Env, ids: string[]): Promise<number> {
	let deleted = 0;
	const affectedMailboxes = new Set<string>();
	for (const idsChunk of chunk(ids, 50)) {
		const { mailboxIds, keys } = await kvKeysForMessageIds(env, idsChunk);
		for (const id of mailboxIds) affectedMailboxes.add(id);

		const placeholders = idsChunk.map(() => '?').join(',');
		// Delete children explicitly so cleanup does not depend on foreign-key pragmas.
		const batch = await env.DB.batch([
			env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${placeholders})`).bind(...idsChunk),
			env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...idsChunk),
		]);
		deleted += batch[1]?.meta.changes ?? 0;

		for (const keyChunk of chunk(keys, 100)) {
			try {
				await Promise.all(keyChunk.map((key) => env.ATTACHMENTS.delete(key)));
			} catch (error) {
				// The rows are gone; a KV failure only leaves unreferenced objects behind.
				console.error('muse.mail.kv_delete_failed', error);
			}
		}
	}
	for (const mailboxId of affectedMailboxes) await recalcMailbox(env, mailboxId);
	return deleted;
}

export function isOverQuota(
	mailbox: Pick<MailboxRow, 'quota_bytes' | 'quota_messages' | 'used_bytes' | 'used_messages'>,
): boolean {
	return (
		(mailbox.quota_messages > 0 && mailbox.used_messages > mailbox.quota_messages) ||
		(mailbox.quota_bytes > 0 && mailbox.used_bytes > mailbox.quota_bytes)
	);
}

/** Delete the oldest messages until the mailbox is inside its quotas. */
export async function trimMailbox(env: Env, mailboxId: string, maxDelete = 2000): Promise<number> {
	let deleted = 0;
	while (deleted < maxDelete) {
		const row = await env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mailboxId).first<MailboxRow>();
		if (!row) break;
		const neededCount = Math.max(0, row.quota_messages > 0 ? row.used_messages - row.quota_messages : 0);
		const neededBytes = Math.max(0, row.quota_bytes > 0 ? row.used_bytes - row.quota_bytes : 0);
		if (neededCount === 0 && neededBytes === 0) break;

		const oldest = await env.DB.prepare(
			'SELECT id, stored_bytes FROM messages WHERE mailbox_id = ? ORDER BY received_at ASC, rowid ASC LIMIT 500',
		)
			.bind(mailboxId)
			.all<{ id: string; stored_bytes: number }>();
		if (oldest.results.length === 0) break;

		// Delete only enough of the oldest mail to get back inside both quotas.
		const ids: string[] = [];
		let freed = 0;
		for (const message of oldest.results) {
			ids.push(message.id);
			freed += message.stored_bytes;
			if (ids.length >= neededCount && freed >= neededBytes) break;
		}
		if (ids.length === 0) break;

		const removed = await deleteMessagesByIds(env, ids);
		deleted += removed;
		if (removed === 0) break;
	}
	return deleted;
}

/** Delete every message older than the cutoff, or all messages when cutoff is null. */
export async function purgeMailbox(
	env: Env,
	mailboxId: string,
	beforeIso: string | null,
	maxDelete = 5000,
): Promise<number> {
	let deleted = 0;
	while (deleted < maxDelete) {
		const statement = beforeIso
			? env.DB.prepare(
					'SELECT id FROM messages WHERE mailbox_id = ? AND received_at < ? ORDER BY received_at ASC LIMIT 100',
				)
			: env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ? ORDER BY received_at ASC LIMIT 100');
		const rows = beforeIso
			? await statement.bind(mailboxId, beforeIso).all<{ id: string }>()
			: await statement.bind(mailboxId).all<{ id: string }>();
		if (rows.results.length === 0) break;
		const removed = await deleteMessagesByIds(
			env,
			rows.results.map((row) => row.id),
		);
		deleted += removed;
		if (removed === 0) break;
	}
	return deleted;
}

export async function countMailboxMessages(
	env: Env,
	mailboxId: string,
	beforeIso: string | null,
): Promise<number> {
	const row = beforeIso
		? await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ? AND received_at < ?')
				.bind(mailboxId, beforeIso)
				.first<{ count: number }>()
		: await env.DB.prepare('SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?')
				.bind(mailboxId)
				.first<{ count: number }>();
	return row?.count ?? 0;
}

/**
 * Remove a mailbox, its mail, and its connection resource.
 *
 * The resource row is what grants and the console's scope matrix point at, so
 * deleting only the mailbox would leave an address that looks reachable but no
 * longer exists.
 */
export async function deleteMailbox(env: Env, mailbox: MailboxRow): Promise<number> {
	const removed = await purgeMailbox(env, mailbox.id, null, 20_000);
	// Clear anything beyond the purge cap before dropping the mailbox.
	await env.DB.batch([
		env.DB.prepare(
			'DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE mailbox_id = ?)',
		).bind(mailbox.id),
		env.DB.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailbox.id),
		env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mailbox.id),
		env.DB.prepare('DELETE FROM connection_resources WHERE connection_id = ? AND resource_key = ?').bind(
			mailbox.connection_id,
			mailbox.address,
		),
	]);
	return removed;
}

export async function writeMailAudit(
	env: Env,
	accountId: string,
	actor: string,
	action: string,
	detail: Record<string, unknown> | null = null,
): Promise<void> {
	await env.DB.prepare('INSERT INTO mail_audit (account_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)')
		.bind(accountId, nowIso(), actor, action, detail ? JSON.stringify(detail) : null)
		.run();
}
