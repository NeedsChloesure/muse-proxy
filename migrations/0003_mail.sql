PRAGMA foreign_keys = ON;

-- Mail -----------------------------------------------------------------------
--
-- Mail is hosted by this Worker rather than proxied to an upstream service. A
-- mailbox is a collection on the account's single 'mail' connection, so the
-- existing two-layer permission model applies unchanged: the connection's
-- resource ceiling and the key's grant, per mailbox.
--
-- Small attachments live in D1; larger ones live in KV under
-- att/<mailbox_id>/<message_id>/<attachment_id>. Mailbox, message and
-- attachment ids are preserved by the Maildrop import script so those KV keys
-- keep resolving.

CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
	address TEXT NOT NULL UNIQUE,
	local_part TEXT NOT NULL,
	domain TEXT NOT NULL,
	display_name TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	quota_bytes INTEGER NOT NULL DEFAULT 0,
	quota_messages INTEGER NOT NULL DEFAULT 0,
	overflow TEXT NOT NULL DEFAULT 'trim_oldest' CHECK (overflow IN ('trim_oldest', 'reject_new')),
	retention_days INTEGER NOT NULL DEFAULT 0,
	used_bytes INTEGER NOT NULL DEFAULT 0,
	used_messages INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_mailboxes_account ON mailboxes (account_id);
CREATE INDEX idx_mailboxes_connection ON mailboxes (connection_id);
CREATE INDEX idx_mailboxes_domain ON mailboxes (domain);

CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
	source_hash TEXT NOT NULL,
	message_id TEXT,
	in_reply_to TEXT,
	references_header TEXT,
	envelope_from TEXT,
	envelope_to TEXT,
	from_addr TEXT,
	from_name TEXT,
	to_json TEXT,
	cc_json TEXT,
	reply_to_json TEXT,
	subject TEXT,
	received_at TEXT NOT NULL,
	sent_at TEXT,
	size_bytes INTEGER NOT NULL,
	stored_bytes INTEGER NOT NULL,
	attachment_count INTEGER NOT NULL DEFAULT 0,
	has_attachments INTEGER NOT NULL DEFAULT 0,
	is_read INTEGER NOT NULL DEFAULT 0,
	is_starred INTEGER NOT NULL DEFAULT 0,
	preview TEXT,
	text_body TEXT,
	html_body TEXT,
	body_truncated INTEGER NOT NULL DEFAULT 0,
	raw_storage TEXT CHECK (raw_storage IN ('d1')),
	raw_data BLOB,
	raw_key TEXT,
	headers_json TEXT,
	parse_error TEXT,
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_messages_source ON messages (mailbox_id, source_hash);
CREATE INDEX idx_messages_mailbox_received ON messages (mailbox_id, received_at DESC, id DESC);
CREATE INDEX idx_messages_mailbox_unread ON messages (mailbox_id, is_read, received_at DESC);
CREATE INDEX idx_messages_received ON messages (received_at);

CREATE TABLE attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
	filename TEXT,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	content_id TEXT,
	disposition TEXT,
	is_inline INTEGER NOT NULL DEFAULT 0,
	storage TEXT NOT NULL CHECK (storage IN ('d1', 'kv', 'unavailable')),
	data BLOB,
	kv_key TEXT,
	sha256 TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_attachments_message ON attachments (message_id);

CREATE TABLE mail_audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	detail TEXT
);

CREATE INDEX idx_mail_audit_account ON mail_audit (account_id, at DESC);

-- Mail is a singleton service per account; the console manages mailboxes, not
-- the connection. This index makes a concurrent first-use race harmless.
CREATE UNIQUE INDEX idx_connections_mail_singleton ON connections (account_id) WHERE provider = 'mail';
