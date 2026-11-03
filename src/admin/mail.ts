/**
 * The mail console API.
 *
 * Session-authenticated and same-origin, like every other admin route. Mailbox
 * administration lives here rather than on the agent surface: an API key can
 * read and manage mail inside the mailboxes it was granted, but only the account
 * owner can create, reconfigure or delete a mailbox.
 */

import { Hono } from 'hono';

import { requireSameOrigin, requireSession, type AppBindings, type AppContext } from '../auth/middleware';
import * as repo from '../db/repo';
import { HttpError, json } from '../lib/http';
import { optionalInt, optionalOneOf, optionalString, readJson, requiredString } from '../lib/validate';
import { mailConfigFrom } from '../mail/config';
import { ensureMailConnection } from '../mail/connection';
import {
	countMailboxMessages,
	deleteMailbox,
	deleteMessagesByIds,
	getAttachmentForAccount,
	getMailboxForAccount,
	getMessageForAccount,
	isOverQuota,
	listAttachments,
	listMailboxes,
	listMessages,
	mailboxStats,
	purgeMailbox,
	trimMailbox,
	writeMailAudit,
	type MailboxRow,
} from '../mail/db';
import { contentDisposition, decodeCursor, encodeCursor, normalizeAddress, toArrayBuffer } from '../mail/lib';
import { applyMailboxChanges, createMailbox, resolveAddressInput } from '../mail/mailboxes';
import { mailboxView, messageDetail, messageSummary, statsView } from '../mail/serialize';
import { API_VERSION } from '../types';

export const mailRoutes = new Hono<AppBindings>();

mailRoutes.use('*', requireSession, requireSameOrigin);

const ADMIN_BASE = '/api/admin/mail';

function account(c: AppContext) {
	return c.get('session').account;
}

async function mailboxFor(c: AppContext, rawAddress: string): Promise<MailboxRow> {
	const address = normalizeAddress(rawAddress);
	const mailbox = await getMailboxForAccount(c.env, account(c).id, address);
	if (!mailbox) throw new HttpError(404, 'mailbox_not_found', `No mailbox exists for ${address}.`);
	return mailbox;
}

async function view(c: AppContext, mailbox: MailboxRow): Promise<Record<string, unknown>> {
	const resource = await repo.getResourceByKey(c.env.DB, mailbox.connection_id, mailbox.address);
	return mailboxView(mailbox, { resourceId: resource?.id ?? null, maxAccess: resource?.maxAccess ?? 'none' });
}

function parseIso(value: string | undefined, field: string): string | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new HttpError(422, 'invalid_parameter', `${field} must be an ISO 8601 timestamp.`);
	}
	return new Date(timestamp).toISOString();
}

function flag(value: string | undefined): boolean {
	return value === '1' || value === 'true';
}

function limitParam(value: string | undefined, fallback = 50, max = 200): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw new HttpError(422, 'invalid_parameter', `limit must be an integer between 1 and ${max}.`);
	}
	return parsed;
}

function booleanField(body: Record<string, unknown>, field: string): boolean | undefined {
	if (body[field] === undefined) return undefined;
	if (typeof body[field] !== 'boolean') {
		throw new HttpError(400, 'invalid_request', `'${field}' must be a boolean.`);
	}
	return body[field];
}

/* -------------------------------------------------------------------------- */
/* Mailboxes                                                                  */
/* -------------------------------------------------------------------------- */

mailRoutes.get('/', async (c) => {
	const connection = await ensureMailConnection(c.env, account(c).id);
	const rows = await listMailboxes(c.env, account(c).id, connection.id);
	const resources = await repo.listResources(c.env.DB, connection.id);
	const byKey = new Map(resources.map((resource) => [resource.resourceKey, resource]));

	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: {
			connectionId: connection.id,
			mailboxes: rows.map((row) =>
				mailboxView(row, {
					resourceId: byKey.get(row.address)?.id ?? null,
					maxAccess: byKey.get(row.address)?.maxAccess ?? 'none',
				}),
			),
		},
	});
});

mailRoutes.post('/mailboxes', async (c) => {
	const body = await readJson(c.req.raw);
	const rawAddress = requiredString(body, 'address', { max: 254 });
	const address = resolveAddressInput(rawAddress, mailConfigFrom(c.env).defaultDomain);

	const displayName = optionalString(body, 'displayName', { max: 200 }) ?? null;
	const overflow = optionalOneOf(body, 'overflow', ['trim_oldest', 'reject_new'] as const) ?? 'trim_oldest';

	const connection = await ensureMailConnection(c.env, account(c).id);
	const mailbox = await createMailbox(c.env, {
		accountId: account(c).id,
		connectionId: connection.id,
		address,
		displayName,
		quotaBytes: optionalInt(body, 'quotaBytes', { min: 0, max: 1_000_000_000_000 }) ?? 0,
		quotaMessages: optionalInt(body, 'quotaMessages', { min: 0, max: 10_000_000 }) ?? 0,
		retentionDays: optionalInt(body, 'retentionDays', { min: 0, max: 3650 }) ?? 0,
		overflow,
	});

	await writeMailAudit(c.env, account(c).id, account(c).username, 'mailbox.create', { address });
	return json({ ok: true, apiVersion: API_VERSION, data: { mailbox: await view(c, mailbox) } }, { status: 201 });
});

mailRoutes.get('/mailboxes/:address', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: { mailbox: await view(c, mailbox), stats: statsView(await mailboxStats(c.env, mailbox.id)) },
	});
});

mailRoutes.patch('/mailboxes/:address', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	const body = await readJson(c.req.raw);
	const changes: Parameters<typeof applyMailboxChanges>[2] = {};

	if (body.displayName !== undefined) {
		changes.displayName = body.displayName === null ? null : (optionalString(body, 'displayName', { max: 200 }) ?? null);
	}
	const enabled = booleanField(body, 'enabled');
	if (enabled !== undefined) changes.enabled = enabled;
	const quotaBytes = optionalInt(body, 'quotaBytes', { min: 0, max: 1_000_000_000_000 });
	if (quotaBytes !== undefined) changes.quotaBytes = quotaBytes;
	const quotaMessages = optionalInt(body, 'quotaMessages', { min: 0, max: 10_000_000 });
	if (quotaMessages !== undefined) changes.quotaMessages = quotaMessages;
	const retentionDays = optionalInt(body, 'retentionDays', { min: 0, max: 3650 });
	if (retentionDays !== undefined) changes.retentionDays = retentionDays;
	const overflow = optionalOneOf(body, 'overflow', ['trim_oldest', 'reject_new'] as const);
	if (overflow !== undefined) changes.overflow = overflow;

	if (Object.keys(changes).length === 0) {
		throw new HttpError(422, 'no_changes', 'Provide at least one field to update.');
	}

	const updated = await applyMailboxChanges(c.env, mailbox, changes);
	await writeMailAudit(c.env, account(c).id, account(c).username, 'mailbox.update', { address: mailbox.address });
	return json({ ok: true, apiVersion: API_VERSION, data: { mailbox: await view(c, updated) } });
});

mailRoutes.delete('/mailboxes/:address', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	const deletedMessages = await deleteMailbox(c.env, mailbox);
	await writeMailAudit(c.env, account(c).id, account(c).username, 'mailbox.delete', {
		address: mailbox.address,
		deletedMessages,
	});
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: { deleted: true, address: mailbox.address, deletedMessages },
	});
});

mailRoutes.get('/mailboxes/:address/messages', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	const cursorRaw = c.req.query('cursor');
	const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
	if (cursorRaw && !cursor) throw new HttpError(422, 'invalid_cursor', 'cursor is not valid.');

	const result = await listMessages(c.env, {
		mailboxId: mailbox.id,
		limit: limitParam(c.req.query('limit')),
		cursor,
		order: c.req.query('order') === 'asc' ? 'asc' : 'desc',
		since: parseIso(c.req.query('since'), 'since'),
		before: parseIso(c.req.query('before'), 'before'),
		unread: flag(c.req.query('unread')),
		starred: flag(c.req.query('starred')),
		hasAttachments: flag(c.req.query('hasAttachments') ?? c.req.query('has_attachments')),
		search: (c.req.query('q') ?? '').trim().slice(0, 200) || null,
	});

	const last = result.rows[result.rows.length - 1];
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: {
			mailbox: await view(c, mailbox),
			messages: result.rows.map((row) => messageSummary(row, mailbox.address)),
			hasMore: result.hasMore,
			nextCursor: result.hasMore && last ? encodeCursor({ receivedAt: last.received_at, id: last.id }) : null,
		},
	});
});

mailRoutes.get('/mailboxes/:address/stats', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: { mailbox: await view(c, mailbox), stats: statsView(await mailboxStats(c.env, mailbox.id)) },
	});
});

mailRoutes.post('/mailboxes/:address/trim', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	const deleted = await trimMailbox(c.env, mailbox.id);
	await writeMailAudit(c.env, account(c).id, account(c).username, 'mailbox.trim', { address: mailbox.address, deleted });
	const refreshed = await getMailboxForAccount(c.env, account(c).id, mailbox.address);
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: {
			deleted,
			withinQuota: refreshed ? !isOverQuota(refreshed) : true,
			mailbox: refreshed ? await view(c, refreshed) : null,
		},
	});
});

mailRoutes.post('/mailboxes/:address/purge', async (c) => {
	const mailbox = await mailboxFor(c, c.req.param('address'));
	const body = await readJson(c.req.raw);
	const all = booleanField(body, 'all') ?? false;
	const days = optionalInt(body, 'olderThanDays', { min: 1, max: 36500 });
	const before = body.before === undefined || body.before === null ? null : parseIso(String(body.before), 'before');

	if (!all && days === undefined && !before) {
		throw new HttpError(422, 'no_selector', 'Provide "all": true, olderThanDays, or before.');
	}

	const cutoff = all ? null : (before ?? new Date(Date.now() - (days ?? 1) * 86_400_000).toISOString());
	const deleted = await purgeMailbox(c.env, mailbox.id, cutoff);
	const remaining = await countMailboxMessages(c.env, mailbox.id, cutoff);
	await writeMailAudit(c.env, account(c).id, account(c).username, 'mailbox.purge', {
		address: mailbox.address,
		cutoff,
		deleted,
		remaining,
	});
	const refreshed = await getMailboxForAccount(c.env, account(c).id, mailbox.address);
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: {
			deleted,
			remaining,
			hasMore: remaining > 0,
			mailbox: refreshed ? await view(c, refreshed) : null,
		},
	});
});

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

async function messageFor(c: AppContext, id: string) {
	const message = await getMessageForAccount(c.env, account(c).id, id);
	if (!message) throw new HttpError(404, 'message_not_found', 'No message exists with that id.');
	return message;
}

mailRoutes.get('/messages/:id', async (c) => {
	const message = await messageFor(c, c.req.param('id'));
	const attachments = await listAttachments(c.env, message.id);
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: { message: messageDetail(message, attachments, ADMIN_BASE) },
	});
});

mailRoutes.patch('/messages/:id', async (c) => {
	const message = await messageFor(c, c.req.param('id'));
	const body = await readJson(c.req.raw);
	const isRead = booleanField(body, 'isRead');
	const isStarred = booleanField(body, 'isStarred');
	if (isRead === undefined && isStarred === undefined) {
		throw new HttpError(422, 'no_changes', 'Provide isRead and/or isStarred.');
	}

	const sets: string[] = [];
	const values: unknown[] = [];
	if (isRead !== undefined) {
		sets.push('is_read = ?');
		values.push(isRead ? 1 : 0);
	}
	if (isStarred !== undefined) {
		sets.push('is_starred = ?');
		values.push(isStarred ? 1 : 0);
	}
	values.push(message.id);
	await c.env.DB.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();

	const refreshed = await messageFor(c, message.id);
	const attachments = await listAttachments(c.env, refreshed.id);
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: { message: messageDetail(refreshed, attachments, ADMIN_BASE) },
	});
});

mailRoutes.delete('/messages/:id', async (c) => {
	const message = await messageFor(c, c.req.param('id'));
	await deleteMessagesByIds(c.env, [message.id]);
	await writeMailAudit(c.env, account(c).id, account(c).username, 'message.delete', {
		id: message.id,
		mailbox: message.mailbox_address,
	});
	return json({ ok: true, apiVersion: API_VERSION, data: { deleted: true, id: message.id } });
});

mailRoutes.get('/messages/:id/raw', async (c) => {
	const message = await messageFor(c, c.req.param('id'));
	if (message.raw_storage !== 'd1' && !message.raw_key) {
		throw new HttpError(
			404,
			'raw_unavailable',
			'Raw source was not retained for this message because it exceeded RAW_INLINE_MAX.',
		);
	}

	let bytes: ArrayBuffer;
	if (message.raw_storage === 'd1') {
		bytes = toArrayBuffer(message.raw_data);
	} else {
		const stored = await c.env.ATTACHMENTS.get(message.raw_key as string, 'arrayBuffer');
		if (!stored) throw new HttpError(410, 'raw_missing', 'Raw source is no longer stored.');
		bytes = stored;
	}

	return new Response(bytes, {
		headers: {
			'content-type': 'message/rfc822',
			'content-disposition': contentDisposition(`${message.id}.eml`),
			'cache-control': 'private, no-store',
		},
	});
});

mailRoutes.get('/attachments/:id', async (c) => {
	const attachment = await getAttachmentForAccount(c.env, account(c).id, c.req.param('id'));
	if (!attachment) throw new HttpError(404, 'attachment_not_found', 'No attachment exists with that id.');
	if (attachment.storage === 'unavailable') {
		throw new HttpError(410, 'attachment_unavailable', 'This attachment could not be stored.');
	}

	let bytes: ArrayBuffer | null = null;
	if (attachment.storage === 'd1') {
		bytes = toArrayBuffer(attachment.data);
	} else if (attachment.kv_key) {
		bytes = await c.env.ATTACHMENTS.get(attachment.kv_key, 'arrayBuffer');
	}
	if (!bytes || bytes.byteLength === 0) {
		throw new HttpError(410, 'attachment_missing', 'Attachment content is no longer stored.');
	}

	return new Response(bytes, {
		headers: {
			'content-type': attachment.mime_type || 'application/octet-stream',
			'content-disposition': contentDisposition(attachment.filename ?? attachment.id),
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
		},
	});
});

