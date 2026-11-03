/**
 * Mail as a provider.
 *
 * Mail is local: the Worker stores the mail itself, so this connection has no
 * upstream to authenticate against. It still uses the provider contract so the
 * agent router, the ACL intersection and the console's key matrix treat a
 * mailbox exactly like a calendar: one resource, one ceiling, one grant.
 */

import { listMailboxesForConnection } from '../../mail/db';
import type { AdminProviderCtx, OpenApiFragment, ProviderResult, ServiceProvider } from '../types';
import { handleMailRequest } from './api';
import { mailOpenApi } from './openapi';

export const mailProvider: ServiceProvider = {
	type: 'mail',
	displayName: 'Mail',
	summary: 'Inbound email stored by this Worker, with per-mailbox read/write scoping.',
	docsPath: '/docs/agent/mail.html',
	openapiPath: '/api/agent/mail/openapi.json',
	defaultAuthType: 'none',
	authTypes: ['none'],
	local: true,
	requiresCredentials: false,
	fields: [],
	credentials: {
		usernameLabel: 'Mailbox',
		secretLabel: 'Password',
		usernameRequired: false,
		help: 'Mail is hosted by Muse Proxy. There is no upstream credential to store.',
	},

	validateConfig(): Record<string, unknown> {
		return {};
	},

	verifyConfig(): void {
		// Nothing is dialled, so there is no SSRF or TLS policy to apply.
	},

	async test(): Promise<{ ok: true }> {
		return { ok: true };
	},

	async discover(ctx: AdminProviderCtx) {
		const mailboxes = await listMailboxesForConnection(ctx.env, ctx.connectionId);
		return mailboxes.map((mailbox) => ({
			resourceKey: mailbox.address,
			kind: 'mailbox',
			displayName: mailbox.display_name ?? mailbox.address,
			meta: { source: 'discovered', enabled: Boolean(mailbox.enabled) },
		}));
	},

	openapi(): OpenApiFragment {
		return mailOpenApi;
	},

	async handle(ctx): Promise<ProviderResult> {
		return handleMailRequest(ctx);
	},
};
