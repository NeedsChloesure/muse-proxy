/** Typed client for the admin API. Same origin, so no CORS and cookies just work. */

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		credentials: 'same-origin',
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = null;
	}

	if (!response.ok) {
		const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
		throw new ApiError(
			response.status,
			error?.code ?? 'request_failed',
			error?.message ?? `Request failed with HTTP ${response.status}.`,
			error?.details,
		);
	}

	return ((payload as { data?: T } | null)?.data ?? (payload as T)) as T;
}

// -- types -------------------------------------------------------------------

export type Access = 'none' | 'read' | 'write';
export type GrantAccess = 'read' | 'write';

export interface Account {
	id: string;
	username: string;
	isAdmin: boolean;
	createdAt: number;
	disabledAt: number | null;
	connectionCount?: number;
}

/**
 * A config field a provider declares. The connection form renders whatever the
 * selected provider declares, so a new service needs no console changes.
 */
export interface ProviderField {
	name: string;
	label: string;
	type: 'text' | 'url' | 'number' | 'password' | 'select';
	required?: boolean;
	placeholder?: string;
	help?: string;
	options?: string[];
	default?: string;
}

export interface ProviderCredentials {
	usernameLabel: string;
	secretLabel: string;
	usernameRequired: boolean;
	help?: string;
}

export interface ProviderInfo {
	type: string;
	displayName: string;
	summary: string;
	defaultAuthType: string;
	docsUrl: string;
	fields: ProviderField[];
	credentials: ProviderCredentials;
	/** Hosted by this Worker (mail); managed from its own console page. */
	local: boolean;
}

export interface Meta {
	signupEnabled: boolean;
	hasAccounts: boolean;
	apiVersion: string;
	providers: ProviderInfo[];
}

export interface ConnectionResource {
	id: string;
	resourceKey: string;
	kind: string;
	displayName: string | null;
	maxAccess: Access;
	source: string;
}

export interface Connection {
	id: string;
	provider: string;
	label: string;
	/** Null for token-only auth types. */
	username: string | null;
	authType: string;
	/** Provider-owned; rendered from that provider's declared fields. */
	config: Record<string, unknown>;
	status: string;
	lastError: string | null;
	secretHint: string;
	createdAt: number;
	updatedAt: number;
	resources: ConnectionResource[];
}

/** One-line summary of a connection's provider config, for list views. */
export function configSummary(config: Record<string, unknown>, fields: readonly ProviderField[]): string {
	for (const field of fields) {
		const value = config[field.name];
		if (typeof value === 'string' && value) return value;
	}
	const first = Object.values(config).find((value) => typeof value === 'string' && value);
	return typeof first === 'string' ? first : '';
}

export interface Grant {
	id?: string;
	connectionId: string;
	resourceKey: string;
	maxAccess: GrantAccess;
}

export interface ApiKeySummary {
	id: string;
	name: string;
	prefix: string;
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	active: boolean;
	grants?: Grant[];
}

export interface TestResult {
	ok: boolean;
	error?: string;
}

// -- mail --------------------------------------------------------------------

export type MailOverflow = 'trim_oldest' | 'reject_new';

export interface Mailbox {
	id: string;
	connectionId: string;
	address: string;
	displayName: string | null;
	enabled: boolean;
	quotaBytes: number;
	quotaMessages: number;
	overflow: MailOverflow;
	retentionDays: number;
	usedBytes: number;
	usedMessages: number;
	createdAt: string;
	updatedAt: string;
	lastReceivedAt: string | null;
	resourceId: string | null;
	maxAccess: Access;
}

export interface MailAddress {
	address: string;
	name: string;
}

export interface MailAttachment {
	id: string;
	messageId: string;
	filename: string | null;
	mimeType: string;
	sizeBytes: number;
	contentId: string | null;
	disposition: string | null;
	isInline: boolean;
	storage: string;
	available: boolean;
	url: string;
	sha256: string | null;
}

export interface MailMessage {
	id: string;
	mailbox: string;
	subject: string;
	from: MailAddress;
	envelopeFrom: string | null;
	to: MailAddress[];
	cc: MailAddress[];
	replyTo: MailAddress[];
	receivedAt: string;
	sentAt: string | null;
	messageId: string | null;
	inReplyTo: string | null;
	references: string | null;
	preview: string;
	sizeBytes: number;
	storedBytes: number;
	hasAttachments: boolean;
	attachmentCount: number;
	isRead: boolean;
	isStarred: boolean;
	rawAvailable: boolean;
	parseError: string | null;
}

export interface MailMessageDetail extends MailMessage {
	text: string;
	html: string;
	bodyTruncated: boolean;
	headers: { key: string; value: string }[];
	attachments: MailAttachment[];
	rawUrl: string;
}

export interface MailStats {
	messages: number;
	unread: number;
	bytes: number;
	oldestAt: string | null;
	newestAt: string | null;
	attachments: { storage: string; count: number; bytes: number }[];
}

export interface MailboxDetail {
	mailbox: Mailbox;
	stats: MailStats;
}

export interface MailMessageQuery {
	limit?: number;
	cursor?: string | null;
	order?: 'asc' | 'desc';
	since?: string;
	before?: string;
	unread?: boolean;
	starred?: boolean;
	hasAttachments?: boolean;
	q?: string;
}

// -- endpoints ---------------------------------------------------------------

export const api = {
	meta: () => request<Meta>('GET', '/api/admin/meta'),

	me: () => request<{ account: Account; signupEnabled: boolean }>('GET', '/api/admin/auth/me'),

	login: (username: string, password: string) =>
		request<{ account: Account }>('POST', '/api/admin/auth/login', { username, password }),

	signup: (username: string, password: string) =>
		request<{ account: Account }>('POST', '/api/admin/auth/signup', { username, password }),

	logout: () => request<{ signedOut: boolean }>('POST', '/api/admin/auth/logout'),

	changePassword: (currentPassword: string, newPassword: string) =>
		request<{ updated: boolean }>('POST', '/api/admin/auth/password', { currentPassword, newPassword }),

	connections: {
		list: () => request<{ connections: Connection[] }>('GET', '/api/admin/connections'),
		get: (id: string) => request<{ connection: Connection }>('GET', `/api/admin/connections/${id}`),
		create: (input: {
			provider: string;
			label: string;
			config: Record<string, unknown>;
			username?: string;
			secret: string;
		}) => request<{ connection: Connection | null; test: TestResult; warnings: string[] }>('POST', '/api/admin/connections', input),
		update: (id: string, input: Record<string, unknown>) =>
			request<{ connection: Connection }>('PATCH', `/api/admin/connections/${id}`, input),
		remove: (id: string) => request<{ deleted: string }>('DELETE', `/api/admin/connections/${id}`),
		test: (id: string) => request<{ test: TestResult; connection: Connection }>('POST', `/api/admin/connections/${id}/test`),
		discover: (id: string) => request<{ connection: Connection }>('POST', `/api/admin/connections/${id}/discover`),
		addResource: (id: string, input: { resourceKey: string; displayName?: string; kind?: string; maxAccess?: Access }) =>
			request<{ connection: Connection }>('POST', `/api/admin/connections/${id}/resources`, input),
		setResourceAccess: (id: string, resourceId: string, maxAccess: Access) =>
			request<{ connection: Connection }>('PATCH', `/api/admin/connections/${id}/resources/${resourceId}`, { maxAccess }),
		removeResource: (id: string, resourceId: string) =>
			request<{ connection: Connection }>('DELETE', `/api/admin/connections/${id}/resources/${resourceId}`),
	},

	keys: {
		list: () => request<{ keys: ApiKeySummary[] }>('GET', '/api/admin/keys'),
		get: (id: string) => request<{ key: ApiKeySummary; grants: Grant[] }>('GET', `/api/admin/keys/${id}`),
		create: (input: { name: string; expiresInDays?: number; grants: Grant[] }) =>
			request<{ key: ApiKeySummary; grants: Grant[]; token: string }>('POST', '/api/admin/keys', input),
		update: (id: string, input: { name?: string; expiresInDays?: number }) =>
			request<{ key: ApiKeySummary }>('PATCH', `/api/admin/keys/${id}`, input),
		/** Permanently removes the key, its grants, and any notices it has not read. */
		remove: (id: string) => request<{ deleted: string }>('DELETE', `/api/admin/keys/${id}`),
		setGrants: (id: string, grants: Grant[]) => request<{ grants: Grant[] }>('PUT', `/api/admin/keys/${id}/grants`, { grants }),
	},

	mail: {
		list: () => request<{ connectionId: string; mailboxes: Mailbox[] }>('GET', '/api/admin/mail'),
		createMailbox: (input: {
			address: string;
			displayName?: string | null;
			quotaBytes?: number;
			quotaMessages?: number;
			overflow?: MailOverflow;
			retentionDays?: number;
		}) => request<{ mailbox: Mailbox }>('POST', '/api/admin/mail/mailboxes', input),
		getMailbox: (address: string) =>
			request<MailboxDetail>('GET', `/api/admin/mail/mailboxes/${encodeURIComponent(address)}`),
		updateMailbox: (
			address: string,
			input: {
				displayName?: string | null;
				enabled?: boolean;
				quotaBytes?: number;
				quotaMessages?: number;
				overflow?: MailOverflow;
				retentionDays?: number;
			},
		) => request<{ mailbox: Mailbox }>('PATCH', `/api/admin/mail/mailboxes/${encodeURIComponent(address)}`, input),
		deleteMailbox: (address: string) =>
			request<{ deleted: boolean; address: string; deletedMessages: number }>(
				'DELETE',
				`/api/admin/mail/mailboxes/${encodeURIComponent(address)}`,
			),
		messages: (address: string, query: MailMessageQuery = {}) => {
			const params = new URLSearchParams();
			if (query.limit !== undefined) params.set('limit', String(query.limit));
			if (query.cursor) params.set('cursor', query.cursor);
			if (query.order) params.set('order', query.order);
			if (query.since) params.set('since', query.since);
			if (query.before) params.set('before', query.before);
			if (query.unread) params.set('unread', 'true');
			if (query.starred) params.set('starred', 'true');
			if (query.hasAttachments) params.set('hasAttachments', 'true');
			if (query.q) params.set('q', query.q);
			const suffix = params.toString();
			return request<{ mailbox: Mailbox; messages: MailMessage[]; hasMore: boolean; nextCursor: string | null }>(
				'GET',
				`/api/admin/mail/mailboxes/${encodeURIComponent(address)}/messages${suffix ? `?${suffix}` : ''}`,
			);
		},
		trim: (address: string) =>
			request<{ deleted: number; withinQuota: boolean; mailbox: Mailbox | null }>(
				'POST',
				`/api/admin/mail/mailboxes/${encodeURIComponent(address)}/trim`,
			),
		purge: (address: string, input: { all?: boolean; olderThanDays?: number; before?: string }) =>
			request<{ deleted: number; remaining: number; hasMore: boolean; mailbox: Mailbox | null }>(
				'POST',
				`/api/admin/mail/mailboxes/${encodeURIComponent(address)}/purge`,
				input,
			),
		getMessage: (id: string) => request<{ message: MailMessageDetail }>('GET', `/api/admin/mail/messages/${id}`),
		updateMessage: (id: string, input: { isRead?: boolean; isStarred?: boolean }) =>
			request<{ message: MailMessageDetail }>('PATCH', `/api/admin/mail/messages/${id}`, input),
		deleteMessage: (id: string) => request<{ deleted: boolean; id: string }>('DELETE', `/api/admin/mail/messages/${id}`),
	},

	accounts: {
		list: () => request<{ accounts: Account[] }>('GET', '/api/admin/accounts'),
		create: (input: { username: string; password: string; isAdmin?: boolean }) =>
			request<{ account: Account }>('POST', '/api/admin/accounts', input),
		update: (id: string, input: { isAdmin?: boolean; disabled?: boolean }) =>
			request<{ account: Account }>('PATCH', `/api/admin/accounts/${id}`, input),
	},
};

export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error) return error.message;
	return 'Something went wrong.';
}
