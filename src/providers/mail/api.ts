/**
 * The agent-facing mail API.
 *
 * Mounted by the router at /api/agent/mail/<connectionId>; everything after the
 * connection id is handled here. Access is the same intersection the rest of the
 * gateway uses: each mailbox is a connection resource, and every request is
 * resolved to one mailbox before ctx.require runs.
 */

import { Hono } from 'hono';

import { HttpError, json, toErrorResponse } from '../../lib/http';
import {
	countMailboxMessages,
	deleteMessagesByIds,
	getAttachmentForAccount,
	getMailboxForConnection,
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
	type MessageWithAddress,
} from '../../mail/db';
import { contentDisposition, decodeCursor, encodeCursor, normalizeAddress, toArrayBuffer } from '../../mail/lib';
import { mailboxView, messageDetail, messageSummary, statsView } from '../../mail/serialize';
import { ACCESS_RANK, API_VERSION, type Access } from '../../types';
import type { AgentCtx, ProviderResult } from '../types';

const MAIL_BASE = '/api/agent/mail';

function ok(data: unknown): Response {
	return json({ ok: true, apiVersion: API_VERSION, data });
}

function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new HttpError(422, 'invalid_parameter', `limit must be an integer between ${min} and ${max}.`);
	}
	return parsed;
}

function isoParam(value: string | undefined, field: string): string | null {
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

function boolField(body: Record<string, unknown>, field: string): boolean | undefined {
	if (body[field] === undefined) return undefined;
	if (typeof body[field] !== 'boolean') {
		throw new HttpError(400, 'invalid_request', `'${field}' must be a boolean.`);
	}
	return body[field];
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw new HttpError(400, 'invalid_request', 'Request body must be valid JSON.');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
	}
	return parsed as Record<string, unknown>;
}

function requireAccess(ctx: AgentCtx, address: string, required: Exclude<Access, 'none'>, message?: string): void {
	ctx.require(ctx.decide({ resourceKey: address, connectionScope: false }), required, message);
}

async function mailboxFor(ctx: AgentCtx, rawAddress: string): Promise<MailboxRow> {
	const address = normalizeAddress(rawAddress);
	const mailbox = await getMailboxForConnection(ctx.env, ctx.account.id, ctx.connection.id, address);
	if (!mailbox) throw new HttpError(404, 'mailbox_not_found', `No mailbox exists for ${address}.`);
	return mailbox;
}

async function messageFor(ctx: AgentCtx, id: string): Promise<MessageWithAddress> {
	const message = await getMessageForAccount(ctx.env, ctx.account.id, id);
	if (!message || message.mailbox_connection_id !== ctx.connection.id) {
		throw new HttpError(404, 'message_not_found', 'No message exists with that id.');
	}
	requireAccess(ctx, message.mailbox_address, 'read');
	return message;
}

async function mailboxViewFor(ctx: AgentCtx, mailbox: MailboxRow): Promise<Record<string, unknown>> {
	const decision = ctx.decide({ resourceKey: mailbox.address, connectionScope: false });
	return mailboxView(mailbox, { maxAccess: decision.access });
}

async function listReachable(ctx: AgentCtx): Promise<Record<string, unknown>[]> {
	const rows = await listMailboxes(ctx.env, ctx.account.id, ctx.connection.id);
	const out: Record<string, unknown>[] = [];
	for (const row of rows) {
		const decision = ctx.decide({ resourceKey: row.address, connectionScope: false });
		if (ACCESS_RANK[decision.access] >= ACCESS_RANK.read) {
			out.push(mailboxView(row, { maxAccess: decision.access }));
		}
	}
	return out;
}

async function listMessagesResponse(ctx: AgentCtx, mailbox: MailboxRow, query: URLSearchParams): Promise<Response> {
	const cursorRaw = query.get('cursor') ?? undefined;
	const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
	if (cursorRaw && !cursor) throw new HttpError(422, 'invalid_cursor', 'cursor is not valid.');

	const result = await listMessages(ctx.env, {
		mailboxId: mailbox.id,
		limit: intParam(query.get('limit') ?? undefined, 50, 1, 200),
		cursor,
		order: query.get('order') === 'asc' ? 'asc' : 'desc',
		since: isoParam(query.get('since') ?? undefined, 'since'),
		before: isoParam(query.get('before') ?? undefined, 'before'),
		unread: flag(query.get('unread') ?? undefined),
		starred: flag(query.get('starred') ?? undefined),
		hasAttachments: flag(query.get('hasAttachments') ?? query.get('has_attachments') ?? undefined),
		search: (query.get('q') ?? '').trim().slice(0, 200) || null,
	});

	const last = result.rows[result.rows.length - 1];
	return ok({
		mailbox: await mailboxViewFor(ctx, mailbox),
		messages: result.rows.map((row) => messageSummary(row, mailbox.address)),
		hasMore: result.hasMore,
		nextCursor: result.hasMore && last ? encodeCursor({ receivedAt: last.received_at, id: last.id }) : null,
	});
}

async function purge(
	ctx: AgentCtx,
	mailbox: MailboxRow,
	body: Record<string, unknown>,
): Promise<Response> {
	const all = boolField(body, 'all') ?? false;
	const rawDays = body.olderThanDays;
	let days: number | undefined;
	if (rawDays !== undefined && rawDays !== null) {
		if (typeof rawDays !== 'number' || !Number.isInteger(rawDays) || rawDays < 1 || rawDays > 36500) {
			throw new HttpError(400, 'invalid_request', "'olderThanDays' must be an integer between 1 and 36500.");
		}
		days = rawDays;
	}
	const before =
		body.before === undefined || body.before === null ? null : isoParam(String(body.before), 'before');

	if (!all && days === undefined && !before) {
		throw new HttpError(422, 'no_selector', 'Provide "all": true, olderThanDays, or before.');
	}

	const cutoff = all ? null : (before ?? new Date(Date.now() - (days ?? 1) * 86_400_000).toISOString());
	const deleted = await purgeMailbox(ctx.env, mailbox.id, cutoff);
	const remaining = await countMailboxMessages(ctx.env, mailbox.id, cutoff);
	await writeMailAudit(ctx.env, ctx.account.id, ctx.key.name || ctx.key.prefix, 'mailbox.purge', {
		address: mailbox.address,
		cutoff,
		deleted,
		remaining,
	});

	const refreshed = await getMailboxForConnection(ctx.env, ctx.account.id, ctx.connection.id, mailbox.address);
	return ok({
		deleted,
		remaining,
		hasMore: remaining > 0,
		mailbox: refreshed ? await mailboxViewFor(ctx, refreshed) : null,
	});
}

function createApp(ctx: AgentCtx): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	const base = `${MAIL_BASE}/${encodeURIComponent(ctx.connection.id)}`;

	app.get('/', async () => ok({ connection: { id: ctx.connection.id, label: ctx.connection.label }, mailboxes: await listReachable(ctx) }));

	app.get('/mailboxes', async () => ok({ mailboxes: await listReachable(ctx) }));

	app.get('/mailboxes/:address', async (c) => {
		const mailbox = await mailboxFor(ctx, c.req.param('address'));
		requireAccess(ctx, mailbox.address, 'read');
		return ok({ mailbox: await mailboxViewFor(ctx, mailbox), stats: statsView(await mailboxStats(ctx.env, mailbox.id)) });
	});

	app.get('/mailboxes/:address/messages', async (c) => {
		const mailbox = await mailboxFor(ctx, c.req.param('address'));
		requireAccess(ctx, mailbox.address, 'read');
		return listMessagesResponse(ctx, mailbox, new URL(c.req.url).searchParams);
	});

	app.get('/mailboxes/:address/stats', async (c) => {
		const mailbox = await mailboxFor(ctx, c.req.param('address'));
		requireAccess(ctx, mailbox.address, 'read');
		return ok({ mailbox: await mailboxViewFor(ctx, mailbox), stats: statsView(await mailboxStats(ctx.env, mailbox.id)) });
	});

	app.post('/mailboxes/:address/trim', async (c) => {
		const mailbox = await mailboxFor(ctx, c.req.param('address'));
		requireAccess(ctx, mailbox.address, 'write');
		const deleted = await trimMailbox(ctx.env, mailbox.id);
		await writeMailAudit(ctx.env, ctx.account.id, ctx.key.name || ctx.key.prefix, 'mailbox.trim', {
			address: mailbox.address,
			deleted,
		});
		const refreshed = await getMailboxForConnection(ctx.env, ctx.account.id, ctx.connection.id, mailbox.address);
		return ok({
			deleted,
			withinQuota: refreshed ? !isOverQuota(refreshed) : true,
			mailbox: refreshed ? await mailboxViewFor(ctx, refreshed) : null,
		});
	});

	app.post('/mailboxes/:address/purge', async (c) => {
		const mailbox = await mailboxFor(ctx, c.req.param('address'));
		requireAccess(ctx, mailbox.address, 'write');
		return purge(ctx, mailbox, await readJsonBody(c.req.raw));
	});

	app.get('/messages/:id', async (c) => {
		const message = await messageFor(ctx, c.req.param('id'));
		const attachments = await listAttachments(ctx.env, message.id);
		return ok({ message: messageDetail(message, attachments, base) });
	});

	app.patch('/messages/:id', async (c) => {
		const message = await messageFor(ctx, c.req.param('id'));
		requireAccess(ctx, message.mailbox_address, 'write');
		const body = await readJsonBody(c.req.raw);
		const isRead = boolField(body, 'isRead');
		const isStarred = boolField(body, 'isStarred');
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
		await ctx.env.DB.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();

		const refreshed = await messageFor(ctx, message.id);
		const attachments = await listAttachments(ctx.env, refreshed.id);
		return ok({ message: messageDetail(refreshed, attachments, base) });
	});

	app.delete('/messages/:id', async (c) => {
		const message = await messageFor(ctx, c.req.param('id'));
		requireAccess(ctx, message.mailbox_address, 'write');
		await deleteMessagesByIds(ctx.env, [message.id]);
		await writeMailAudit(ctx.env, ctx.account.id, ctx.key.name || ctx.key.prefix, 'message.delete', {
			id: message.id,
			mailbox: message.mailbox_address,
		});
		return ok({ deleted: true, id: message.id });
	});

	app.get('/messages/:id/raw', async (c) => {
		const message = await messageFor(ctx, c.req.param('id'));
		if (message.raw_storage !== 'd1' && !message.raw_key) {
			throw new HttpError(404, 'raw_unavailable', 'Raw source was not retained for this message.');
		}

		let bytes: ArrayBuffer;
		if (message.raw_storage === 'd1') {
			bytes = toArrayBuffer(message.raw_data);
		} else {
			const stored = await ctx.env.ATTACHMENTS.get(message.raw_key as string, 'arrayBuffer');
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

	app.get('/attachments/:id', async (c) => {
		const attachment = await getAttachmentForAccount(ctx.env, ctx.account.id, c.req.param('id'));
		if (!attachment || attachment.mailbox_connection_id !== ctx.connection.id) {
			throw new HttpError(404, 'attachment_not_found', 'No attachment exists with that id.');
		}
		requireAccess(ctx, attachment.mailbox_address, 'read');

		if (attachment.storage === 'unavailable') {
			throw new HttpError(410, 'attachment_unavailable', 'This attachment could not be stored.');
		}

		let bytes: ArrayBuffer | null = null;
		if (attachment.storage === 'd1') {
			bytes = toArrayBuffer(attachment.data);
		} else if (attachment.kv_key) {
			bytes = await ctx.env.ATTACHMENTS.get(attachment.kv_key, 'arrayBuffer');
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

	app.notFound(() => {
		throw new HttpError(404, 'not_found', 'Unknown mail endpoint.');
	});

	// Hono is a sub-app inside the provider; without this it would answer a
	// guided HttpError with its own generic 500 instead of the proxy's JSON
	// problem, and an agent would lose the permittedResources guidance.
	app.onError((error) => toErrorResponse(error));

	return app;
}

export async function handleMailRequest(ctx: AgentCtx): Promise<ProviderResult> {
	const app = createApp(ctx);
	// ctx.rawPath is the path after the connection id, with its own leading
	// slash. Rebuilding a request against it keeps Hono's normal routing and
	// percent-decoding while leaving the method, headers and body intact.
	const url = new URL(ctx.request.url);
	url.pathname = ctx.rawPath && ctx.rawPath !== '' ? ctx.rawPath : '/';
	const request = new Request(url.toString(), ctx.request);
	const response = await app.fetch(request, ctx.env);
	return { response };
}
