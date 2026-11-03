/**
 * Inbound mail.
 *
 * Cloudflare Email Routing delivers a message the moment a recipient matches a
 * mailbox row. Everything here is deliberately Maildrop's flow: reject unknown
 * or disabled recipients, parse with postal-mime, store small attachments in
 * D1 and large ones in KV, then write the message, attachment rows and mailbox
 * counters in one D1 batch so a retry finds either all of it or none of it.
 */

import PostalMime from 'postal-mime';

import { KV_VALUE_LIMIT, mailConfigFrom } from './config';
import { getMailboxByAddress, mailboxRecalcStatement, trimMailbox } from './db';
import { errorMessage, newId, normalizeAddress, nowIso, sha256Hex, toText } from './lib';

interface ParsedAddress {
	name: string;
	address?: string;
	group?: ParsedAddress[];
}

interface ParsedAttachment {
	filename: string | null;
	mimeType: string;
	disposition: string | null;
	related?: boolean;
	contentId?: string;
	content: ArrayBuffer | Uint8Array | string;
}

interface ParsedEmail {
	from?: ParsedAddress;
	to?: ParsedAddress[];
	cc?: ParsedAddress[];
	replyTo?: ParsedAddress[];
	subject?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string;
	date?: string;
	text?: string;
	html?: string;
	attachments: ParsedAttachment[];
	headers: { key: string; value: string }[];
}

export type IngestOutcome =
	| { status: 'stored'; messageId: string }
	| { status: 'duplicate'; messageId: string }
	| { status: 'rejected'; reason: string };

const MAX_ATTACHMENTS = 50;

function clip(value: string | null | undefined, length: number): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > length ? trimmed.slice(0, length) : trimmed;
}

function firstMailbox(address: ParsedAddress | undefined): { address: string; name: string } | null {
	if (!address) return null;
	if (address.group && address.group.length > 0) return firstMailbox(address.group[0]);
	if (!address.address) return null;
	return { address: normalizeAddress(address.address), name: (address.name ?? '').trim() };
}

function flattenAddresses(addresses: ParsedAddress[] | undefined): { address: string; name: string }[] {
	const out: { address: string; name: string }[] = [];
	for (const address of addresses ?? []) {
		if (address.group) {
			out.push(...flattenAddresses(address.group));
		} else if (address.address) {
			out.push({ address: normalizeAddress(address.address), name: (address.name ?? '').trim() });
		}
	}
	return out;
}

function htmlToText(html: string): string {
	return html
		.replace(/<(?:br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, '\n')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function collapse(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function attachmentBytes(content: ParsedAttachment['content']): Uint8Array {
	if (typeof content === 'string') return new TextEncoder().encode(content);
	if (content instanceof Uint8Array) return content;
	return new Uint8Array(content);
}

function safeMimeType(value: string): string {
	const base = (value.split(';')[0] ?? '').trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : 'application/octet-stream';
}

function reject(reason: string, detail: Record<string, unknown>): IngestOutcome {
	console.log('muse.mail.rejected', JSON.stringify({ ...detail, reason }));
	return { status: 'rejected', reason };
}

/**
 * Quota conditions throw instead of calling setReject(). Cloudflare surfaces an
 * uncaught handler error as a 521; some sending servers retry that, while others
 * bounce it. This is deliberately best-effort: there is no transient-failure API.
 */
function defer(reason: string, detail: Record<string, unknown>): never {
	console.warn('muse.mail.deferred', JSON.stringify({ ...detail, reason }));
	throw new Error(reason);
}

async function cleanupKvObjects(env: Env, keys: string[]): Promise<void> {
	await Promise.all(
		keys.map(async (key) => {
			try {
				await env.ATTACHMENTS.delete(key);
			} catch (error) {
				console.error('muse.mail.kv_cleanup_failed', JSON.stringify({ key, error: errorMessage(error) }));
			}
		}),
	);
}

export async function ingestEmail(message: ForwardableEmailMessage, env: Env): Promise<IngestOutcome> {
	const config = mailConfigFrom(env);
	const to = normalizeAddress(message.to);
	const logBase = { to, from: normalizeAddress(message.from), size: message.rawSize };

	const mailbox = await getMailboxByAddress(env, to);
	if (!mailbox) return reject('Recipient address is not configured', logBase);
	if (!mailbox.enabled) return reject('This mailbox is disabled', logBase);
	if (message.rawSize > config.maxMessageBytes) {
		return reject(`Message exceeds the ${config.maxMessageBytes} byte limit`, logBase);
	}
	if (mailbox.quota_bytes > 0 && message.rawSize > mailbox.quota_bytes) {
		defer('Message is larger than the mailbox quota', logBase);
	}

	const wouldExceedMessages =
		mailbox.quota_messages > 0 && mailbox.used_messages + 1 > mailbox.quota_messages;
	const wouldExceedBytes =
		mailbox.quota_bytes > 0 && mailbox.used_bytes + message.rawSize > mailbox.quota_bytes;
	if (mailbox.overflow === 'reject_new' && (wouldExceedMessages || wouldExceedBytes)) {
		defer('Mailbox is full', logBase);
	}

	let raw: ArrayBuffer;
	try {
		raw = await new Response(message.raw).arrayBuffer();
	} catch (error) {
		console.error('muse.mail.read_failed', errorMessage(error));
		throw error;
	}
	if (raw.byteLength > config.maxMessageBytes) {
		return reject(`Message exceeds the ${config.maxMessageBytes} byte limit`, logBase);
	}

	let parsed: ParsedEmail | null = null;
	let parseError: string | null = null;
	try {
		parsed = (await PostalMime.parse(raw, {
			maxNestingDepth: 50,
			maxPartCount: 2000,
			maxHeadersSize: 512 * 1024,
			maxForwardedAddresses: 2000,
		})) as unknown as ParsedEmail;
	} catch (error) {
		parseError = clip(errorMessage(error), 500);
		console.warn('muse.mail.parse_failed', JSON.stringify({ ...logBase, error: parseError }));
	}

	if (!parsed && raw.byteLength > config.rawInlineMax) {
		return reject('Message could not be parsed and is too large to retain as raw source', logBase);
	}

	const sourceHash = await sha256Hex(raw);
	const duplicate = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ? AND source_hash = ?')
		.bind(mailbox.id, sourceHash)
		.first<{ id: string }>();
	if (duplicate) {
		console.log('muse.mail.duplicate', JSON.stringify({ ...logBase, id: duplicate.id }));
		return { status: 'duplicate', messageId: duplicate.id };
	}

	const messageId = newId('msg', 16);
	const receivedAt = nowIso();
	let text = toText(parsed?.text ?? '', config.maxBodyBytes);
	let html = toText(parsed?.html ?? '', config.maxBodyBytes);

	// Keep text + HTML inside one D1 row budget even when both limits are raised.
	const BODY_BUDGET = 1_700_000;
	if (text.bytes + html.bytes > BODY_BUDGET) {
		html = toText(html.text, Math.max(0, BODY_BUDGET - text.bytes));
		if (text.bytes > BODY_BUDGET) text = toText(text.text, BODY_BUDGET);
	}

	const from = firstMailbox(parsed?.from);
	const subject = clip(parsed?.subject, 1000) ?? '(no subject)';
	const previewSource = text.text || (html.text ? htmlToText(html.text) : '');
	const preview = clip(collapse(previewSource).slice(0, 500), 500);

	let sentAt: string | null = null;
	if (parsed?.date) {
		const timestamp = Date.parse(parsed.date);
		if (Number.isFinite(timestamp)) sentAt = new Date(timestamp).toISOString();
	}

	const headerList = parsed?.headers?.length
		? parsed.headers.slice(0, 200).map((header) => ({ key: header.key, value: header.value }))
		: (() => {
				const list: { key: string; value: string }[] = [];
				message.headers.forEach((value, key) => list.push({ key, value }));
				return list.slice(0, 200);
			})();
	// Build valid JSON within a size budget; a truncated JSON blob is useless.
	const keptHeaders: { key: string; value: string }[] = [];
	let headerBudgetBytes = 2;
	const headerEncoder = new TextEncoder();
	for (const header of headerList) {
		const entry = { key: header.key.slice(0, 200), value: header.value.slice(0, 2000) };
		const size = headerEncoder.encode(JSON.stringify(entry)).length + 1;
		if (headerBudgetBytes + size > 30_000) break;
		keptHeaders.push(entry);
		headerBudgetBytes += size;
	}
	const headersJson = JSON.stringify(keptHeaders);
	const headerBytes = headerEncoder.encode(headersJson).length;

	// D1 caps a row at 2 MB. Retain raw source only when it fits alongside the
	// parsed bodies and headers; the default limits are far below this guard.
	const rawStored =
		raw.byteLength <= config.rawInlineMax && raw.byteLength + text.bytes + html.bytes + headerBytes < 1_900_000;

	let storedBytes = (rawStored ? raw.byteLength : 0) + text.bytes + html.bytes;
	const rawData = rawStored ? new Uint8Array(raw) : null;

	const attachments = parsed?.attachments ?? [];
	const attachmentRows: {
		id: string;
		filename: string | null;
		mimeType: string;
		size: number;
		contentId: string | null;
		disposition: string | null;
		isInline: number;
		storage: 'd1' | 'kv' | 'unavailable';
		data: Uint8Array | null;
		kvKey: string | null;
		hash: string;
	}[] = [];

	const uploadedKvKeys: string[] = [];
	let attachmentBytesStored = 0;
	for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
		const bytes = attachmentBytes(attachment.content);
		if (bytes.byteLength === 0 && !attachment.filename) continue;

		const attachmentId = newId('att', 12);
		const wantsInline = bytes.byteLength <= config.inlineAttachmentMax;
		let storage: 'd1' | 'kv' | 'unavailable' = wantsInline ? 'd1' : 'kv';
		const data: Uint8Array | null = wantsInline ? bytes : null;
		let kvKey: string | null = null;

		if (!wantsInline) {
			if (bytes.byteLength > KV_VALUE_LIMIT) {
				storage = 'unavailable';
			} else {
				kvKey = `att/${mailbox.id}/${messageId}/${attachmentId}`;
				uploadedKvKeys.push(kvKey);
				try {
					await env.ATTACHMENTS.put(kvKey, bytes);
				} catch (error) {
					// Nothing has reached D1 yet. Fail delivery and remove any earlier KV
					// objects from this attempt rather than storing a partial message.
					console.error('muse.mail.kv_put_failed', errorMessage(error));
					await cleanupKvObjects(env, uploadedKvKeys);
					throw error;
				}
			}
		}

		if (storage !== 'unavailable') attachmentBytesStored += bytes.byteLength;
		attachmentRows.push({
			id: attachmentId,
			filename: clip(attachment.filename, 300),
			mimeType: safeMimeType(attachment.mimeType || 'application/octet-stream'),
			size: bytes.byteLength,
			contentId: clip(attachment.contentId, 500),
			disposition: clip(attachment.disposition, 50),
			isInline: attachment.related || attachment.disposition === 'inline' ? 1 : 0,
			storage,
			data,
			kvKey,
			hash: await sha256Hex(bytes),
		});
	}

	storedBytes += attachmentBytesStored;

	// One D1 batch = one transaction. A retry after any failure either finds the
	// complete message or finds nothing and can store it again.
	const insertStatement = env.DB.prepare(
		`INSERT INTO messages (
		   id, mailbox_id, source_hash, message_id, in_reply_to, references_header,
		   envelope_from, envelope_to, from_addr, from_name, to_json, cc_json, reply_to_json,
		   subject, received_at, sent_at, size_bytes, stored_bytes, attachment_count, has_attachments,
		   is_read, is_starred, preview, text_body, html_body, body_truncated,
		   raw_storage, raw_data, raw_key, headers_json, parse_error, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
	).bind(
		messageId,
		mailbox.id,
		sourceHash,
		clip(parsed?.messageId, 1000),
		clip(parsed?.inReplyTo, 1000),
		clip(parsed?.references, 4000),
		clip(normalizeAddress(message.from), 320),
		clip(to, 320),
		clip(from?.address, 320),
		clip(from?.name, 300),
		JSON.stringify(flattenAddresses(parsed?.to)),
		JSON.stringify(flattenAddresses(parsed?.cc)),
		JSON.stringify(flattenAddresses(parsed?.replyTo)),
		subject,
		receivedAt,
		sentAt,
		raw.byteLength,
		storedBytes,
		attachmentRows.length,
		attachmentRows.length > 0 ? 1 : 0,
		preview,
		text.text || null,
		html.text || null,
		text.truncated || html.truncated ? 1 : 0,
		rawStored ? 'd1' : null,
		rawData,
		headersJson,
		parseError,
		receivedAt,
	);

	const attachmentStatements = attachmentRows.map((row) =>
		env.DB.prepare(
			`INSERT INTO attachments (
			   id, message_id, filename, mime_type, size_bytes, content_id, disposition,
			   is_inline, storage, data, kv_key, sha256, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			row.id,
			messageId,
			row.filename,
			row.mimeType,
			row.size,
			row.contentId,
			row.disposition,
			row.isInline,
			row.storage,
			row.data,
			row.kvKey,
			row.hash,
			receivedAt,
		),
	);

	try {
		await env.DB.batch([insertStatement, ...attachmentStatements, mailboxRecalcStatement(env, mailbox.id, receivedAt)]);
	} catch (error) {
		await cleanupKvObjects(env, uploadedKvKeys);

		// A concurrent delivery of the same source can win the unique index. In
		// that case this attempt is a duplicate, not a failure.
		const existing = await env.DB.prepare('SELECT id FROM messages WHERE mailbox_id = ? AND source_hash = ?')
			.bind(mailbox.id, sourceHash)
			.first<{ id: string }>();
		if (existing) {
			console.log('muse.mail.duplicate', JSON.stringify({ ...logBase, id: existing.id }));
			return { status: 'duplicate', messageId: existing.id };
		}

		console.error('muse.mail.store_failed', JSON.stringify({ ...logBase, error: errorMessage(error) }));
		throw error;
	}

	if (mailbox.overflow === 'trim_oldest') await trimMailbox(env, mailbox.id);

	console.log(
		'muse.mail.stored',
		JSON.stringify({
			...logBase,
			id: messageId,
			mailbox: mailbox.address,
			attachments: attachmentRows.length,
			storedBytes,
		}),
	);

	return { status: 'stored', messageId };
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const outcome = await ingestEmail(message, env);
	if (outcome.status === 'rejected') message.setReject(outcome.reason);
}
