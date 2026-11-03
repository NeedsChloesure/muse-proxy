/**
 * JSON views for mail resources.
 *
 * One implementation serves both the console (/api/admin/mail) and the agent
 * provider (/api/agent/mail/<connectionId>). Only the URLs for downloads differ,
 * so they are built from a base path rather than duplicated per surface.
 */

import type { Access } from '../types';
import type { AttachmentRow, MailboxRow, MailboxStats, MessageWithAddress, MessageListRow } from './db';

export interface MailboxViewInput {
	resourceId?: string | null;
	maxAccess?: Access;
}

export function mailboxView(row: MailboxRow, input: MailboxViewInput = {}): Record<string, unknown> {
	return {
		id: row.id,
		connectionId: row.connection_id,
		address: row.address,
		displayName: row.display_name,
		enabled: Boolean(row.enabled),
		quotaBytes: row.quota_bytes,
		quotaMessages: row.quota_messages,
		overflow: row.overflow,
		retentionDays: row.retention_days,
		usedBytes: row.used_bytes,
		usedMessages: row.used_messages,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastReceivedAt: 'last_received_at' in row ? (row as MailboxRow & { last_received_at: string | null }).last_received_at : null,
		resourceId: input.resourceId ?? null,
		maxAccess: input.maxAccess ?? 'none',
	};
}

export function statsView(stats: MailboxStats): Record<string, unknown> {
	return {
		messages: stats.messages,
		unread: stats.unread,
		bytes: stats.bytes,
		oldestAt: stats.oldest_at,
		newestAt: stats.newest_at,
		attachments: stats.attachments,
	};
}

export function parseAddresses(value: string | null): { address: string; name: string }[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
			.map((item) => ({
				address: typeof item.address === 'string' ? item.address : '',
				name: typeof item.name === 'string' ? item.name : '',
			}))
			.filter((item) => item.address.length > 0);
	} catch {
		return [];
	}
}

export function parseHeaders(value: string | null): { key: string; value: string }[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
			.map((item) => ({
				key: typeof item.key === 'string' ? item.key : '',
				value: typeof item.value === 'string' ? item.value : '',
			}))
			.filter((item) => item.key.length > 0);
	} catch {
		return [];
	}
}

export function attachmentView(row: AttachmentRow, basePath: string): Record<string, unknown> {
	return {
		id: row.id,
		messageId: row.message_id,
		filename: row.filename,
		mimeType: row.mime_type,
		sizeBytes: row.size_bytes,
		contentId: row.content_id,
		disposition: row.disposition,
		isInline: Boolean(row.is_inline),
		storage: row.storage,
		available: row.storage !== 'unavailable',
		url: `${basePath}/attachments/${row.id}`,
		sha256: row.sha256,
	};
}

export function messageSummary(row: MessageListRow & { mailbox_address?: string }, mailboxAddress: string): Record<string, unknown> {
	return {
		id: row.id,
		mailbox: mailboxAddress,
		subject: row.subject ?? '',
		from: { address: row.from_addr ?? '', name: row.from_name ?? '' },
		envelopeFrom: row.envelope_from,
		to: parseAddresses(row.to_json),
		cc: parseAddresses(row.cc_json),
		replyTo: parseAddresses(row.reply_to_json),
		receivedAt: row.received_at,
		sentAt: row.sent_at,
		messageId: row.message_id,
		inReplyTo: row.in_reply_to,
		references: row.references_header,
		preview: row.preview ?? '',
		sizeBytes: row.size_bytes,
		storedBytes: row.stored_bytes,
		hasAttachments: Boolean(row.has_attachments),
		attachmentCount: row.attachment_count,
		isRead: Boolean(row.is_read),
		isStarred: Boolean(row.is_starred),
		rawAvailable: row.raw_storage === 'd1' || Boolean(row.raw_key),
		parseError: row.parse_error,
	};
}

export function messageDetail(
	row: MessageWithAddress,
	attachments: AttachmentRow[],
	basePath: string,
): Record<string, unknown> {
	return {
		...messageSummary(row, row.mailbox_address),
		text: row.text_body ?? '',
		html: row.html_body ?? '',
		bodyTruncated: Boolean(row.body_truncated),
		headers: parseHeaders(row.headers_json),
		attachments: attachments.map((attachment) => attachmentView(attachment, basePath)),
		rawUrl: `${basePath}/messages/${row.id}/raw`,
	};
}
