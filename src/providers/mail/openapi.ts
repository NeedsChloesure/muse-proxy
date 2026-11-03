/**
 * OpenAPI declaration for the mail provider's agent surface.
 *
 * Every path here is asserted routable by test/mail.spec.ts, the same way the
 * CalDAV fragment is checked.
 */

import type { OpenApiFragment } from '../types';

const CONNECTION = {
	name: 'connectionId',
	in: 'path',
	required: true,
	description: "The account's Mail connection, as shown in the console.",
	schema: { type: 'string' },
};

const ADDRESS = {
	name: 'address',
	in: 'path',
	required: true,
	description: 'A mailbox address. Percent-encode the @ as %40 when using curl.',
	schema: { type: 'string' },
};

const MESSAGE_ID = {
	name: 'id',
	in: 'path',
	required: true,
	schema: { type: 'string' },
};

const DENIED = {
	description:
		'Denied. The body names required, effective and permittedResources, so a caller can correct itself instead of retrying blindly.',
};

function operation(summary: string, parameters: unknown[], extra: Record<string, unknown> = {}) {
	return {
		summary,
		tags: ['mail'],
		parameters,
		responses: {
			200: { description: 'Success.' },
			401: { description: 'Missing or expired API key.' },
			403: DENIED,
			404: { description: 'No such mailbox, message or attachment visible to this account.' },
		},
		...extra,
	};
}

export const mailOpenApi: OpenApiFragment = {
	paths: {
		'/api/agent/mail/{connectionId}': {
			get: operation('Mailboxes this key can reach on the Mail connection', [CONNECTION]),
		},
		'/api/agent/mail/{connectionId}/mailboxes': {
			get: operation('List mailboxes this key can reach', [CONNECTION]),
		},
		'/api/agent/mail/{connectionId}/mailboxes/{address}': {
			get: operation('Read one mailbox and its usage', [CONNECTION, ADDRESS]),
		},
		'/api/agent/mail/{connectionId}/mailboxes/{address}/messages': {
			get: operation('List messages, newest first, with an opaque cursor', [CONNECTION, ADDRESS], {
				parameters: [CONNECTION, ADDRESS],
				description:
					'Query: limit (1..200), cursor, order=asc|desc, since, before, unread, starred, hasAttachments, q. Messages are summaries; fetch one for bodies and attachment metadata.',
			}),
		},
		'/api/agent/mail/{connectionId}/mailboxes/{address}/stats': {
			get: operation('Usage and attachment totals for one mailbox', [CONNECTION, ADDRESS]),
		},
		'/api/agent/mail/{connectionId}/mailboxes/{address}/trim': {
			post: operation('Delete the oldest mail until the mailbox is inside its quotas (requires write)', [CONNECTION, ADDRESS]),
		},
		'/api/agent/mail/{connectionId}/mailboxes/{address}/purge': {
			post: operation(
				'Delete a range of mail: {"all":true}, {"olderThanDays":30} or {"before":"ISO timestamp"} (requires write)',
				[CONNECTION, ADDRESS],
			),
		},
		'/api/agent/mail/{connectionId}/messages/{id}': {
			get: operation('Read one message with bodies, headers and attachment metadata', [CONNECTION, MESSAGE_ID]),
			patch: operation('Set isRead and/or isStarred (requires write)', [CONNECTION, MESSAGE_ID]),
			delete: operation('Delete one message and its attachments (requires write)', [CONNECTION, MESSAGE_ID]),
		},
		'/api/agent/mail/{connectionId}/messages/{id}/raw': {
			get: operation('Download the retained RFC 822 source, when rawAvailable is true', [CONNECTION, MESSAGE_ID]),
		},
		'/api/agent/mail/{connectionId}/attachments/{id}': {
			get: operation('Download one attachment', [CONNECTION, MESSAGE_ID]),
		},
	},
};
