PRAGMA foreign_keys = ON;

-- Accounts -------------------------------------------------------------------

CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT NOT NULL, -- pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	disabled_at INTEGER,
	-- Brute-force backoff. Reset on a successful sign-in.
	failed_logins INTEGER NOT NULL DEFAULT 0,
	locked_until INTEGER
);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE, -- sha256 of the cookie value; the cookie itself is never stored
	account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	user_agent TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Service connections ---------------------------------------------------------

-- A connection is a stored upstream credential plus its per-resource ACL. What
-- the provider dials (a base URL, a host and port, a database name) is NOT part
-- of the core: it lives in config_json, owned and validated by the provider, so
-- adding a service never means migrating this table. Only the credential pair is
-- core, because injecting it upstream is the product.
CREATE TABLE connections (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	provider TEXT NOT NULL, -- registry key, e.g. 'caldav'
	label TEXT NOT NULL,
	auth_type TEXT NOT NULL DEFAULT 'basic', -- basic | bearer
	username TEXT, -- null for token-only auth types
	secret_ciphertext TEXT NOT NULL, -- v1:<iv_b64>:<ciphertext_b64>, AES-256-GCM
	secret_hint TEXT NOT NULL DEFAULT '••••', -- masked tail, so the console can tell credentials apart
	config_json TEXT NOT NULL DEFAULT '{}', -- provider-owned; format owned by the provider
	status TEXT NOT NULL DEFAULT 'unverified', -- unverified | ok | error
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_connections_account ON connections(account_id);

-- The scope universe a connection exposes (calendars, address books, mailboxes,
-- tables, ...). max_access defaults to 'none': a connection is inert until
-- resources are explicitly opted in.
CREATE TABLE connection_resources (
	id TEXT PRIMARY KEY,
	connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
	resource_key TEXT NOT NULL, -- provider-defined identifier, opaque to the core
	kind TEXT NOT NULL, -- calendar | addressbook | provider-defined
	display_name TEXT,
	max_access TEXT NOT NULL DEFAULT 'none', -- none | read | write
	meta_json TEXT NOT NULL DEFAULT '{}',
	discovered_at INTEGER NOT NULL,
	UNIQUE (connection_id, resource_key)
);
CREATE INDEX idx_resources_connection ON connection_resources(connection_id);

-- API keys and their grants ---------------------------------------------------

CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	prefix TEXT NOT NULL, -- e.g. 'muse_a1b2c3', safe to display
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	revoked_at INTEGER,
	last_used_at INTEGER
);
CREATE INDEX idx_api_keys_account ON api_keys(account_id);

-- resource_key is a specific collection key, or '*' for every collection the
-- connection's own ACL allows.
CREATE TABLE api_key_grants (
	id TEXT PRIMARY KEY,
	key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
	connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
	resource_key TEXT NOT NULL DEFAULT '*',
	max_access TEXT NOT NULL, -- read | write
	UNIQUE (key_id, connection_id, resource_key)
);
CREATE INDEX idx_grants_key ON api_key_grants(key_id);
CREATE INDEX idx_grants_connection ON api_key_grants(connection_id);

-- Notices: how the Worker tells an agent (and its human) that something changed.

CREATE TABLE notices (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	severity TEXT NOT NULL DEFAULT 'info', -- info | warning | critical
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
	resource_key TEXT,
	meta_json TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_notices_account ON notices(account_id, created_at DESC);

CREATE TABLE notice_deliveries (
	notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
	key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
	first_seen_at INTEGER,
	acked_at INTEGER,
	PRIMARY KEY (notice_id, key_id)
);
CREATE INDEX idx_notice_deliveries_pending ON notice_deliveries(key_id, acked_at);

-- Audit trail -----------------------------------------------------------------

CREATE TABLE activity_log (
	id INTEGER PRIMARY KEY,
	account_id TEXT NOT NULL,
	key_id TEXT,
	connection_id TEXT,
	method TEXT NOT NULL,
	path TEXT NOT NULL,
	resource_key TEXT,
	status INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_account_time ON activity_log(account_id, created_at DESC);

-- Key/value settings (e.g. the last API version we emitted update notices for).

CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
