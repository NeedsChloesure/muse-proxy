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
