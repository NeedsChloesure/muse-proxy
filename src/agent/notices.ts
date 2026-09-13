/**
 * Notices — how the Worker tells an agent that something changed.
 *
 * Notices are for the AGENT, not for the human: the human's surfaces are the
 * dashboard and the key list, which state what is true now. A notice states
 * what just changed and is delivered to the affected keys. Agents see the
 * pending count on every response header, fetch the details from
 * /api/agent/notices, and can report them to their human.
 *
 * Storage is one row per (notice, key) in `agent_notices`, carrying the content
 * directly. There is deliberately no account-wide master copy: nothing needs
 * one, and its only consumer used to be the console page this feature no
 * longer has. Acknowledging a notice deletes its rows — the last ack is the
 * deletion, so a notice never outlives the last agent that had not read it.
 */

import {
	createAgentNotice,
	getSetting,
	listActiveApiKeys,
	listAccounts,
	listGrantsForAccount,
	setSetting,
} from '../db/repo';
import { API_VERSION, type NoticeSeverity } from '../types';

export type NoticeTarget =
	| { kind: 'account' }
	| { kind: 'connection'; connectionId: string; resourceKey?: string | null }
	| { kind: 'key'; keyId: string };

export interface EmitNoticeInput {
	accountId: string;
	kind: string;
	severity?: NoticeSeverity;
	title: string;
	body: string;
	connectionId?: string | null;
	resourceKey?: string | null;
	meta?: Record<string, unknown>;
}

interface NoticeContent {
	kind: string;
	severity: NoticeSeverity;
	title: string;
	body: string;
	connectionId: string | null;
	resourceKey: string | null;
	metaJson: string;
}

/** The keys a notice is addressed to, resolved against live keys only. */
async function keysForTarget(db: D1Database, input: EmitNoticeInput, target: NoticeTarget): Promise<string[]> {
	if (target.kind === 'key') return [target.keyId];

	const keys = await listActiveApiKeys(db, input.accountId);
	if (target.kind === 'account') return keys.map((key) => key.id);

	// Connection targeting: every live key holding any grant on the connection,
	// with a resource_key narrowing the match to that collection or a wildcard.
	const grants = await listGrantsForAccount(db, input.accountId);
	const holders = new Set(grants.filter((grant) => grant.connectionId === target.connectionId).map((grant) => grant.keyId));
	if (target.resourceKey === null || target.resourceKey === undefined) return [...holders];

	const exact = new Set(
		grants
			.filter((grant) => grant.connectionId === target.connectionId && (grant.resourceKey === target.resourceKey || grant.resourceKey === '*'))
			.map((grant) => grant.keyId),
	);
	return [...exact];
}

/**
 * Record a notice and deliver it to the affected keys.
 *
 * Delivery is computed in memory from the grants as they are at this instant,
 * which keeps the affected set consistent with what the key may reach now.
 */
export async function emitNotice(db: D1Database, input: EmitNoticeInput, target: NoticeTarget): Promise<void> {
	const now = Date.now();
	const content: NoticeContent = {
		kind: input.kind,
		severity: input.severity ?? 'info',
		title: input.title,
		body: input.body,
		connectionId: input.connectionId ?? null,
		resourceKey: input.resourceKey ?? null,
		metaJson: JSON.stringify(input.meta ?? {}),
	};

	const keyIds = await keysForTarget(db, input, target);
	for (const keyId of keyIds) {
		await createAgentNotice(db, { id: crypto.randomUUID(), keyId, ...content, now });
	}
}

const API_VERSION_SETTING = 'notified_api_version';

let versionCheckedThisIsolate = false;

/**
 * On the first agent request after a deploy, tell every active key that the API
 * version changed, linking the changelog. Cheap: one settings read per isolate.
 */
export async function maybeEmitApiVersionNotice(env: Env): Promise<void> {
	if (versionCheckedThisIsolate) return;
	versionCheckedThisIsolate = true;

	try {
		const seen = await getSetting(env.DB, API_VERSION_SETTING);
		if (seen === API_VERSION) return;

		const accounts = await listAccounts(env.DB);
		for (const account of accounts) {
			const keys = await listActiveApiKeys(env.DB, account.id);
			if (keys.length === 0) continue;
			await emitNotice(
				env.DB,
				{
					accountId: account.id,
					kind: 'api_version_updated',
					severity: 'info',
					title: `Muse Proxy API updated to ${API_VERSION}`,
					body:
						`This deployment serves API version ${API_VERSION}` +
						(seen ? ` (previously ${seen}).` : '.') +
						' Review /docs/changelog.html for anything that affects your tooling.',
					meta: { apiVersion: API_VERSION, previousVersion: seen, docsUrl: '/docs/changelog.html' },
				},
				{ kind: 'account' },
			);
		}

		await setSetting(env.DB, API_VERSION_SETTING, API_VERSION, Date.now());
	} catch (error) {
		// Never let a notice failure break an agent request.
		versionCheckedThisIsolate = false;
		console.error('failed to emit api version notice', error);
	}
}

/** Reset the per-isolate memo. Test-only. */
export function resetApiVersionCheck(): void {
	versionCheckedThisIsolate = false;
}
