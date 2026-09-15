/**
 * D1 query helpers.
 *
 * Rows are mapped from snake_case to the camelCase domain types in src/types.ts
 * so snake_case never leaks past this module.
 */

import type {
	Access,
	Account,
	ApiKey,
	ApiKeyGrant,
	Connection,
	ConnectionResource,
	NoticeSeverity,
	Session,
} from '../types';

type Param = string | number | null;

async function first<T>(db: D1Database, sql: string, params: Param[] = []): Promise<T | null> {
	const statement = db.prepare(sql);
	const bound = params.length > 0 ? statement.bind(...params) : statement;
	return (await bound.first<T>()) ?? null;
}

async function all<T>(db: D1Database, sql: string, params: Param[] = []): Promise<T[]> {
	const statement = db.prepare(sql);
	const bound = params.length > 0 ? statement.bind(...params) : statement;
	const result = await bound.all<T>();
	return result.results ?? [];
}

async function run(db: D1Database, sql: string, params: Param[] = []): Promise<void> {
	const statement = db.prepare(sql);
	const bound = params.length > 0 ? statement.bind(...params) : statement;
	await bound.run();
}

// -- accounts ----------------------------------------------------------------

interface RawAccount {
	id: string;
	username: string;
	password_hash: string;
	is_admin: number;
	created_at: number;
	disabled_at: number | null;
	failed_logins: number;
	locked_until: number | null;
}

function mapAccount(row: RawAccount): Account {
	return {
		id: row.id,
		username: row.username,
		passwordHash: row.password_hash,
		isAdmin: row.is_admin === 1,
		createdAt: row.created_at,
		disabledAt: row.disabled_at,
		failedLogins: row.failed_logins ?? 0,
		lockedUntil: row.locked_until ?? null,
	};
}

export async function countAccounts(db: D1Database): Promise<number> {
	const row = await first<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM accounts');
	return row?.count ?? 0;
}

export async function getAccountById(db: D1Database, id: string): Promise<Account | null> {
	const row = await first<RawAccount>(db, 'SELECT * FROM accounts WHERE id = ?', [id]);
	return row ? mapAccount(row) : null;
}

export async function getAccountByUsername(db: D1Database, username: string): Promise<Account | null> {
	const row = await first<RawAccount>(db, 'SELECT * FROM accounts WHERE username = ? COLLATE NOCASE', [username]);
	return row ? mapAccount(row) : null;
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
	const rows = await all<RawAccount>(db, 'SELECT * FROM accounts ORDER BY created_at ASC');
	return rows.map(mapAccount);
}

export async function createAccount(
	db: D1Database,
	input: { id: string; username: string; passwordHash: string; isAdmin: boolean; createdAt: number },
): Promise<void> {
	await run(db, 'INSERT INTO accounts (id, username, password_hash, is_admin, created_at, disabled_at) VALUES (?, ?, ?, ?, ?, NULL)', [
		input.id,
		input.username,
		input.passwordHash,
		input.isAdmin ? 1 : 0,
		input.createdAt,
	]);
}

export async function createFirstAccount(
	db: D1Database,
	input: { id: string; username: string; passwordHash: string; createdAt: number },
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO accounts (id, username, password_hash, is_admin, created_at, disabled_at)
			 SELECT ?, ?, ?, 1, ?, NULL
			 WHERE NOT EXISTS (SELECT 1 FROM accounts)`,
		)
		.bind(input.id, input.username, input.passwordHash, input.createdAt)
		.run();
	return result.meta.changes === 1;
}
export async function setAccountPassword(db: D1Database, id: string, passwordHash: string): Promise<void> {
	await run(db, 'UPDATE accounts SET password_hash = ? WHERE id = ?', [passwordHash, id]);
}

/** Record a failed sign-in, locking the account once the threshold is hit. */
export async function registerFailedLogin(
	db: D1Database,
	account: Account,
	now: number,
	threshold: number,
	lockMs: number,
): Promise<void> {
	const attempts = account.failedLogins + 1;
	const lockedUntil = attempts >= threshold ? now + lockMs : account.lockedUntil;
	await run(db, 'UPDATE accounts SET failed_logins = ?, locked_until = ? WHERE id = ?', [attempts, lockedUntil, account.id]);
}

export async function clearFailedLogins(db: D1Database, id: string): Promise<void> {
	await run(db, 'UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?', [id]);
}

export async function updateAccountFlags(
	db: D1Database,
	id: string,
	changes: { isAdmin?: boolean; disabledAt?: number | null },
): Promise<void> {
	if (changes.isAdmin !== undefined) {
		await run(db, 'UPDATE accounts SET is_admin = ? WHERE id = ?', [changes.isAdmin ? 1 : 0, id]);
	}
	if (changes.disabledAt !== undefined) {
		await run(db, 'UPDATE accounts SET disabled_at = ? WHERE id = ?', [changes.disabledAt, id]);
	}
}

// -- sessions ----------------------------------------------------------------

interface RawSession {
	id: string;
	token_hash: string;
	account_id: string;
	created_at: number;
	expires_at: number;
	user_agent: string | null;
}

function mapSession(row: RawSession): Session {
	return {
		id: row.id,
		tokenHash: row.token_hash,
		accountId: row.account_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		userAgent: row.user_agent,
	};
}

export async function createSession(
	db: D1Database,
	input: { id: string; tokenHash: string; accountId: string; createdAt: number; expiresAt: number; userAgent: string | null },
): Promise<void> {
	await run(
		db,
		'INSERT INTO sessions (id, token_hash, account_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
		[input.id, input.tokenHash, input.accountId, input.createdAt, input.expiresAt, input.userAgent],
	);
}

export async function getSessionByTokenHash(db: D1Database, tokenHash: string): Promise<Session | null> {
	const row = await first<RawSession>(db, 'SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
	return row ? mapSession(row) : null;
}

export async function deleteSessionByTokenHash(db: D1Database, tokenHash: string): Promise<void> {
	await run(db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

export async function deleteAccountSessions(db: D1Database, accountId: string): Promise<void> {
	await run(db, 'DELETE FROM sessions WHERE account_id = ?', [accountId]);
}

export async function purgeExpiredSessions(db: D1Database, now: number): Promise<void> {
	await run(db, 'DELETE FROM sessions WHERE expires_at <= ?', [now]);
}

// -- connections -------------------------------------------------------------

interface RawConnection {
	id: string;
	account_id: string;
	provider: string;
	label: string;
	auth_type: string;
	username: string | null;
	secret_ciphertext: string;
	secret_hint: string;
	config_json: string;
	status: string;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

function mapConnection(row: RawConnection): Connection {
	return {
		id: row.id,
		accountId: row.account_id,
		provider: row.provider,
		label: row.label,
		authType: row.auth_type,
		username: row.username,
		secretCiphertext: row.secret_ciphertext,
		secretHint: row.secret_hint,
		configJson: row.config_json,
		status: row.status,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function createConnection(
	db: D1Database,
	input: {
		id: string;
		accountId: string;
		provider: string;
		label: string;
		authType: string;
		username: string | null;
		secretCiphertext: string;
		secretHint: string;
		configJson: string;
		now: number;
	},
): Promise<void> {
	await run(
		db,
		`INSERT INTO connections (id, account_id, provider, label, auth_type, username, secret_ciphertext, secret_hint, config_json, status, last_error, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', NULL, ?, ?)`,
		[
			input.id,
			input.accountId,
			input.provider,
			input.label,
			input.authType,
			input.username,
			input.secretCiphertext,
			input.secretHint,
			input.configJson,
			input.now,
			input.now,
		],
	);
}

export async function listConnections(db: D1Database, accountId: string): Promise<Connection[]> {
	const rows = await all<RawConnection>(db, 'SELECT * FROM connections WHERE account_id = ? ORDER BY created_at ASC', [accountId]);
	return rows.map(mapConnection);
}

export async function getConnection(db: D1Database, id: string): Promise<Connection | null> {
	const row = await first<RawConnection>(db, 'SELECT * FROM connections WHERE id = ?', [id]);
	return row ? mapConnection(row) : null;
}

export async function getConnectionForAccount(db: D1Database, id: string, accountId: string): Promise<Connection | null> {
	const row = await first<RawConnection>(db, 'SELECT * FROM connections WHERE id = ? AND account_id = ?', [id, accountId]);
	return row ? mapConnection(row) : null;
}

export async function updateConnection(
	db: D1Database,
	id: string,
	changes: {
		label?: string;
		username?: string | null;
		secretCiphertext?: string;
		secretHint?: string;
		configJson?: string;
		status?: string;
		lastError?: string | null;
		authType?: string;
	},
	now: number,
): Promise<void> {
	const sets: string[] = [];
	const params: Param[] = [];
	if (changes.label !== undefined) {
		sets.push('label = ?');
		params.push(changes.label);
	}
	if (changes.configJson !== undefined) {
		sets.push('config_json = ?');
		params.push(changes.configJson);
	}
	if (changes.username !== undefined) {
		sets.push('username = ?');
		params.push(changes.username);
	}
	if (changes.secretCiphertext !== undefined) {
		sets.push('secret_ciphertext = ?');
		params.push(changes.secretCiphertext);
	}
	if (changes.secretHint !== undefined) {
		sets.push('secret_hint = ?');
		params.push(changes.secretHint);
	}
	if (changes.authType !== undefined) {
		sets.push('auth_type = ?');
		params.push(changes.authType);
	}
	if (changes.status !== undefined) {
		sets.push('status = ?');
		params.push(changes.status);
	}
	if (changes.lastError !== undefined) {
		sets.push('last_error = ?');
		params.push(changes.lastError);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	params.push(now);
	params.push(id);
	await run(db, `UPDATE connections SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function deleteConnection(db: D1Database, id: string): Promise<void> {
	await run(db, 'DELETE FROM connections WHERE id = ?', [id]);
}

// -- connection resources ----------------------------------------------------

interface RawResource {
	id: string;
	connection_id: string;
	resource_key: string;
	kind: string;
	display_name: string | null;
	max_access: string;
	meta_json: string;
	discovered_at: number;
}

function mapResource(row: RawResource): ConnectionResource {
	return {
		id: row.id,
		connectionId: row.connection_id,
		resourceKey: row.resource_key,
		kind: row.kind,
		displayName: row.display_name,
		maxAccess: row.max_access as Access,
		metaJson: row.meta_json,
		discoveredAt: row.discovered_at,
	};
}

/** Insert or refresh a resource. `max_access` is only set on first insert. */
export async function upsertResource(
	db: D1Database,
	input: {
		id: string;
		connectionId: string;
		resourceKey: string;
		kind: string;
		displayName: string | null;
		metaJson: string;
		now: number;
	},
): Promise<void> {
	await run(
		db,
		`INSERT INTO connection_resources (id, connection_id, resource_key, kind, display_name, max_access, meta_json, discovered_at)
		 VALUES (?, ?, ?, ?, ?, 'none', ?, ?)
		 ON CONFLICT (connection_id, resource_key) DO UPDATE SET
		   kind = excluded.kind,
		   display_name = excluded.display_name,
		   meta_json = excluded.meta_json,
		   discovered_at = excluded.discovered_at`,
		[input.id, input.connectionId, input.resourceKey, input.kind, input.displayName, input.metaJson, input.now],
	);
}

export async function listResources(db: D1Database, connectionId: string): Promise<ConnectionResource[]> {
	const rows = await all<RawResource>(db, 'SELECT * FROM connection_resources WHERE connection_id = ? ORDER BY resource_key ASC', [
		connectionId,
	]);
	return rows.map(mapResource);
}

export async function listResourcesForConnections(db: D1Database, connectionIds: string[]): Promise<ConnectionResource[]> {
	if (connectionIds.length === 0) return [];
	const placeholders = connectionIds.map(() => '?').join(', ');
	const rows = await all<RawResource>(
		db,
		`SELECT * FROM connection_resources WHERE connection_id IN (${placeholders}) ORDER BY resource_key ASC`,
		connectionIds,
	);
	return rows.map(mapResource);
}

export async function getResource(db: D1Database, id: string): Promise<ConnectionResource | null> {
	const row = await first<RawResource>(db, 'SELECT * FROM connection_resources WHERE id = ?', [id]);
	return row ? mapResource(row) : null;
}

export async function getResourceByKey(db: D1Database, connectionId: string, resourceKey: string): Promise<ConnectionResource | null> {
	const row = await first<RawResource>(db, 'SELECT * FROM connection_resources WHERE connection_id = ? AND resource_key = ?', [
		connectionId,
		resourceKey,
	]);
	return row ? mapResource(row) : null;
}

export async function setResourceAccess(db: D1Database, id: string, access: Access): Promise<void> {
	await run(db, 'UPDATE connection_resources SET max_access = ? WHERE id = ?', [access, id]);
}

export async function deleteResources(db: D1Database, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => '?').join(', ');
	await run(db, `DELETE FROM connection_resources WHERE id IN (${placeholders})`, ids);
}

// -- api keys ----------------------------------------------------------------

interface RawApiKey {
	id: string;
	account_id: string;
	name: string;
	prefix: string;
	token_hash: string;
	created_at: number;
	expires_at: number | null;
	last_used_at: number | null;
}

function mapApiKey(row: RawApiKey): ApiKey {
	return {
		id: row.id,
		accountId: row.account_id,
		name: row.name,
		prefix: row.prefix,
		tokenHash: row.token_hash,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
	};
}

export async function createApiKey(
	db: D1Database,
	input: { id: string; accountId: string; name: string; prefix: string; tokenHash: string; createdAt: number; expiresAt: number | null },
): Promise<void> {
	await run(
		db,
		'INSERT INTO api_keys (id, account_id, name, prefix, token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
		[input.id, input.accountId, input.name, input.prefix, input.tokenHash, input.createdAt, input.expiresAt],
	);
}

export async function listApiKeys(db: D1Database, accountId: string): Promise<ApiKey[]> {
	const rows = await all<RawApiKey>(db, 'SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at DESC', [accountId]);
	return rows.map(mapApiKey);
}

export async function getApiKey(db: D1Database, id: string): Promise<ApiKey | null> {
	const row = await first<RawApiKey>(db, 'SELECT * FROM api_keys WHERE id = ?', [id]);
	return row ? mapApiKey(row) : null;
}

export async function getApiKeyByTokenHash(db: D1Database, tokenHash: string): Promise<ApiKey | null> {
	const row = await first<RawApiKey>(db, 'SELECT * FROM api_keys WHERE token_hash = ?', [tokenHash]);
	return row ? mapApiKey(row) : null;
}

/** Keys that can still authenticate: revocation deletes, so only expiry can kill one in place. */
export async function listActiveApiKeys(db: D1Database, accountId: string): Promise<ApiKey[]> {
	const rows = await all<RawApiKey>(
		db,
		'SELECT * FROM api_keys WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
		[accountId, Date.now()],
	);
	return rows.map(mapApiKey);
}

export async function updateApiKey(
	db: D1Database,
	id: string,
	changes: { name?: string; expiresAt?: number | null },
): Promise<void> {
	if (changes.name !== undefined) await run(db, 'UPDATE api_keys SET name = ? WHERE id = ?', [changes.name, id]);
	if (changes.expiresAt !== undefined) await run(db, 'UPDATE api_keys SET expires_at = ? WHERE id = ?', [changes.expiresAt, id]);
}

/** Expunge a key outright; grants and unread notices cascade with it. */
export async function deleteApiKey(db: D1Database, id: string): Promise<void> {
	await run(db, 'DELETE FROM api_keys WHERE id = ?', [id]);
}

export async function touchApiKey(db: D1Database, id: string, now: number): Promise<void> {
	await run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, id]);
}

// -- grants ------------------------------------------------------------------

interface RawGrant {
	id: string;
	key_id: string;
	connection_id: string;
	resource_key: string;
	max_access: string;
}

function mapGrant(row: RawGrant): ApiKeyGrant {
	return {
		id: row.id,
		keyId: row.key_id,
		connectionId: row.connection_id,
		resourceKey: row.resource_key,
		maxAccess: row.max_access as Exclude<Access, 'none'>,
	};
}

/** Replace a key's entire grant set. */
export async function replaceGrants(
	db: D1Database,
	keyId: string,
	grants: Array<{ id: string; connectionId: string; resourceKey: string; maxAccess: Exclude<Access, 'none'> }>,
): Promise<void> {
	const statements = [
		db.prepare('DELETE FROM api_key_grants WHERE key_id = ?').bind(keyId),
		...grants.map((grant) =>
			db
				.prepare('INSERT INTO api_key_grants (id, key_id, connection_id, resource_key, max_access) VALUES (?, ?, ?, ?, ?)')
				.bind(grant.id, keyId, grant.connectionId, grant.resourceKey, grant.maxAccess),
		),
	];
	await db.batch(statements);
}

export async function listGrantsForKey(db: D1Database, keyId: string): Promise<ApiKeyGrant[]> {
	const rows = await all<RawGrant>(db, 'SELECT * FROM api_key_grants WHERE key_id = ?', [keyId]);
	return rows.map(mapGrant);
}

export async function listGrantsForKeyConnection(db: D1Database, keyId: string, connectionId: string): Promise<ApiKeyGrant[]> {
	const rows = await all<RawGrant>(db, 'SELECT * FROM api_key_grants WHERE key_id = ? AND connection_id = ?', [keyId, connectionId]);
	return rows.map(mapGrant);
}

export async function listGrantsForAccount(db: D1Database, accountId: string): Promise<Array<ApiKeyGrant & { keyName: string }>> {
	const rows = await all<RawGrant & { key_name: string }>(
		db,			`SELECT g.*, k.name AS key_name FROM api_key_grants g
			 JOIN api_keys k ON k.id = g.key_id
			 WHERE k.account_id = ?`,
			[accountId],
	);
	return rows.map((row) => ({ ...mapGrant(row), keyName: row.key_name }));
}

// -- agent notices -----------------------------------------------------------
//
// One row per (notice, key); the content is carried directly on the row. There
// is no account-wide master copy: notices exist for the agents, and the human's
// surfaces (dashboard, key list) state what is true now rather than what changed.
// Acknowledging deletes, so storage is bounded by what agents have not read.

export interface AgentNotice {
	id: string;
	keyId: string;
	kind: string;
	severity: NoticeSeverity;
	title: string;
	body: string;
	connectionId: string | null;
	resourceKey: string | null;
	metaJson: string;
	createdAt: number;
}

interface RawAgentNotice {
	id: string;
	key_id: string;
	kind: string;
	severity: string;
	title: string;
	body: string;
	connection_id: string | null;
	resource_key: string | null;
	meta_json: string;
	created_at: number;
}

function mapAgentNotice(row: RawAgentNotice): AgentNotice {
	return {
		id: row.id,
		keyId: row.key_id,
		kind: row.kind,
		severity: row.severity as NoticeSeverity,
		title: row.title,
		body: row.body,
		connectionId: row.connection_id,
		resourceKey: row.resource_key,
		metaJson: row.meta_json,
		createdAt: row.created_at,
	};
}

export async function createAgentNotice(
	db: D1Database,
	input: {
		id: string;
		keyId: string;
		kind: string;
		severity: NoticeSeverity;
		title: string;
		body: string;
		connectionId: string | null;
		resourceKey: string | null;
		metaJson: string;
		now: number;
	},
): Promise<void> {
	await run(
		db,
		`INSERT INTO agent_notices (id, key_id, kind, severity, title, body, connection_id, resource_key, meta_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			input.id,
			input.keyId,
			input.kind,
			input.severity,
			input.title,
			input.body,
			input.connectionId,
			input.resourceKey,
			input.metaJson,
			input.now,
		],
	);
}

export async function listPendingAgentNotices(db: D1Database, keyId: string, limit = 50): Promise<AgentNotice[]> {
	const rows = await all<RawAgentNotice>(
		db,
		'SELECT * FROM agent_notices WHERE key_id = ? ORDER BY created_at ASC LIMIT ?',
		[keyId, limit],
	);
	return rows.map(mapAgentNotice);
}

export async function countPendingNoticesForKey(db: D1Database, keyId: string): Promise<number> {
	const row = await first<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM agent_notices WHERE key_id = ?', [keyId]);
	return row?.count ?? 0;
}

/** Acknowledging is deletion: the notice is gone for this key once read. */
export async function deleteAgentNotices(db: D1Database, keyId: string, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => '?').join(', ');
	await run(db, `DELETE FROM agent_notices WHERE key_id = ? AND id IN (${placeholders})`, [keyId, ...ids]);
}

// -- settings ----------------------------------------------------------------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key]);
	return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string, now: number): Promise<void> {
	await run(
		db,
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		[key, value, now],
	);
}
