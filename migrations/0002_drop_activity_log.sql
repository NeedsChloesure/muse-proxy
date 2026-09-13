-- Removes the activity log.
--
-- The table recorded one row per gateway request, forever: an unbounded,
-- append-only write on a deployment meant to run on the Workers Free plan's
-- 500 MB per D1 database budget. A busy agent would have filled it eventually, and the failure
-- mode would have been every gateway request 500ing once the quota was gone.
-- What a human actually needed from it — whether an agent's key is still in
-- use, and what an agent could not do — is carried by api_keys.last_used_at
-- (shown on the Dashboard) and by notices, neither of which grows per request.
--
-- Dropping outright rather than keeping and ignoring it: a dead table still
-- counts toward the quota, and a migration is the cheapest moment to say so.

DROP TABLE IF EXISTS activity_log;

-- Notices become agent-only.
--
-- Two tables used to carry one feature: `notices` (the account-wide master
-- copy, read by the console) and `notice_deliveries` (per-key read/ack state,
-- read by agents). The console half is gone — the notices are for the agents,
-- not for the human, and the dashboard is the human's surface — so the master
-- copy has no reader left and both tables collapse into one.
--
-- `agent_notices` is self-contained: one row per (notice, key), carrying the
-- content directly, deleted on acknowledge. No backfill: a key minted after an
-- event is a key that did not exist when it happened. That also removes the
-- former unbounded-growth path, where dismissed masters kept their deliveries
-- alive forever — here, the last acknowledgement IS the deletion.

DROP TABLE IF EXISTS notice_deliveries;
DROP TABLE IF EXISTS notices;

CREATE TABLE agent_notices (
	id TEXT PRIMARY KEY,
	key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	severity TEXT NOT NULL DEFAULT 'info', -- info | warning | critical
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	connection_id TEXT,
	resource_key TEXT,
	meta_json TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_notices_key ON agent_notices(key_id, created_at DESC);

-- Revocation becomes deletion.
--
-- A revoked key was a row kept forever with a flag: it could never
-- authenticate again, appeared in every listing, and its only reader was the
-- console's "revoked" pill. That is dead weight on a deployment meant to stay
-- inside the Workers Free plan, so DELETE /api/admin/keys/:id now removes the
-- row outright, cascading to its grants and any unread notices.
--
-- The one durable dead state is expiry: an expired key is retained and shown
-- as expired, because the moment it passed is information ("this agent's lease
-- ran out"), and the console's delete button can expunge even those.
--
-- Existing revoked keys are deleted here, not converted: their last-used
-- timestamps are already visible in the dashboard's key summary, which is
-- where "was this key still in use?" is answered now.

DELETE FROM agent_notices WHERE key_id IN (SELECT id FROM api_keys WHERE revoked_at IS NOT NULL);
DELETE FROM api_key_grants WHERE key_id IN (SELECT id FROM api_keys WHERE revoked_at IS NOT NULL);
DELETE FROM api_keys WHERE revoked_at IS NOT NULL;

ALTER TABLE api_keys DROP COLUMN revoked_at;
