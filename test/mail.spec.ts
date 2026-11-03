import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import { adminJson, adminOk, signUp, url } from './helpers';

const testEnv = env as unknown as Env;

interface MailboxView {
	id: string;
	address: string;
	connectionId: string;
	resourceId: string | null;
	maxAccess: string;
	usedMessages: number;
	usedBytes: number;
}

interface MailboxPayload {
	data: { mailbox: MailboxView };
}

interface MessageSummary {
	id: string;
	subject: string;
	from: { address: string; name: string };
	attachments?: { id: string; url: string; storage: string; sizeBytes: number }[];
	text?: string;
}

interface MessageListPayload {
	data: { messages: MessageSummary[]; hasMore: boolean; nextCursor: string | null };
}

interface MessagePayload {
	data: {
		message: MessageSummary & {
			text: string;
			attachments: { id: string; url: string; storage: string; sizeBytes: number }[];
		};
	};
}

function rawEmail(options: {
	to: string;
	subject: string;
	text?: string;
	from?: string;
	attachment?: { filename: string; content: string; contentType?: string };
}): string {
	const boundary = `b${crypto.randomUUID().replace(/-/g, '')}`;
	const lines: string[] = [
		`From: Test Sender <${options.from ?? 'sender@example.net'}>`,
		`To: ${options.to}`,
		`Subject: ${options.subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@example.net>`,
		'MIME-Version: 1.0',
	];

	if (options.attachment) {
		lines.push(
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			options.text ?? 'Hello',
			'',
			`--${boundary}`,
			`Content-Type: ${options.attachment.contentType ?? 'text/plain'}; name="${options.attachment.filename}"`,
			`Content-Disposition: attachment; filename="${options.attachment.filename}"`,
			'',
			options.attachment.content,
			'',
			`--${boundary}--`,
			'',
		);
	} else {
		lines.push('Content-Type: text/plain; charset=utf-8', '', options.text ?? 'Hello', '');
	}
	return lines.join('\r\n');
}

async function deliver(raw: string, to: string): Promise<string | null> {
	let rejected: string | null = null;
	const message = {
		from: 'sender@example.net',
		to,
		headers: new Headers(),
		raw: new Response(raw).body,
		rawSize: new TextEncoder().encode(raw).byteLength,
		setReject(reason: string) {
			rejected = reason;
		},
	} as unknown as ForwardableEmailMessage;
	await worker.email!(message, testEnv);
	return rejected;
}

async function createMailbox(
	cookie: string,
	address: string,
	extra: Record<string, unknown> = {},
): Promise<MailboxView> {
	const payload = await adminOk<MailboxPayload>(cookie, '/api/admin/mail/mailboxes', {
		method: 'POST',
		body: { address, ...extra },
	});
	return payload.data.mailbox;
}

async function createKey(
	cookie: string,
	connectionId: string,
	resourceKey: string,
	maxAccess: 'read' | 'write',
): Promise<string> {
	const payload = await adminOk<{ data: { token: string } }>(cookie, '/api/admin/keys', {
		method: 'POST',
		body: { name: `mail-${maxAccess}`, grants: [{ connectionId, resourceKey, maxAccess }] },
	});
	return payload.data.token;
}

async function enableAccess(cookie: string, mailbox: MailboxView, level: 'read' | 'write'): Promise<void> {
	expect(mailbox.resourceId).toBeTruthy();
	await adminOk(cookie, `/api/admin/connections/${mailbox.connectionId}/resources/${mailbox.resourceId}`, {
		method: 'PATCH',
		body: { maxAccess: level },
	});
}

function agentFetch(
	path: string,
	token: string,
	init: { method?: string; body?: unknown } = {},
): Promise<Response> {
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (init.body !== undefined) headers['content-type'] = 'application/json';
	return SELF.fetch(url(path), {
		method: init.method ?? 'GET',
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

describe('mail', () => {
	it('rejects unknown recipients, dedupes deliveries, and serves bodies and attachments', async () => {
		const { cookie } = await signUp('alice');
		const mailbox = await createMailbox(cookie, 'notes@mail.test');

		expect(await deliver(rawEmail({ to: 'nobody@mail.test', subject: 'Nope' }), 'nobody@mail.test')).toContain(
			'not configured',
		);

		const raw = rawEmail({
			to: 'notes@mail.test',
			subject: 'Hello there',
			text: 'First line\nSecond line',
			attachment: { filename: 'note.txt', content: 'file-content-123' },
		});
		expect(await deliver(raw, 'notes@mail.test')).toBeNull();
		expect(await deliver(raw, 'notes@mail.test')).toBeNull();

		const listed = await adminOk<MessageListPayload>(
			cookie,
			'/api/admin/mail/mailboxes/notes%40mail.test/messages',
		);
		expect(listed.data.messages).toHaveLength(1);
		expect(listed.data.messages[0]?.subject).toBe('Hello there');

		const id = listed.data.messages[0]!.id;
		const detail = await adminOk<MessagePayload>(cookie, `/api/admin/mail/messages/${id}`);
		expect(detail.data.message.text).toContain('Second line');
		expect(detail.data.message.attachments).toHaveLength(1);

		const download = await SELF.fetch(url(detail.data.message.attachments[0]!.url), { headers: { cookie } });
		expect(download.status).toBe(200);
		expect(await download.text()).toContain('file-content-123');

		const rawResponse = await SELF.fetch(url(`/api/admin/mail/messages/${id}/raw`), { headers: { cookie } });
		expect(rawResponse.status).toBe(200);
		expect(await rawResponse.text()).toContain('Subject: Hello there');

		expect(mailbox.usedMessages).toBe(0);
		const usage = await testEnv.DB.prepare('SELECT used_messages FROM mailboxes WHERE address = ?')
			.bind('notes@mail.test')
			.first<{ used_messages: number }>();
		expect(usage?.used_messages).toBe(1);
	});

	it('intersects the mailbox ceiling with the key grant', async () => {
		const { cookie } = await signUp('alice');
		const alpha = await createMailbox(cookie, 'alpha@mail.test');
		const beta = await createMailbox(cookie, 'beta@mail.test');
		expect(await deliver(rawEmail({ to: 'alpha@mail.test', subject: 'One' }), 'alpha@mail.test')).toBeNull();

		const listed = await adminOk<MessageListPayload>(
			cookie,
			'/api/admin/mail/mailboxes/alpha%40mail.test/messages',
		);
		const messageId = listed.data.messages[0]!.id;

		const readToken = await createKey(cookie, alpha.connectionId, 'alpha@mail.test', 'read');
		// The mailbox ceiling is still none, so even a matching grant is refused.
		expect(
			(await agentFetch(`/api/agent/mail/${alpha.connectionId}/mailboxes/alpha%40mail.test/messages`, readToken))
				.status,
		).toBe(403);

		await enableAccess(cookie, alpha, 'read');
		expect(
			(await agentFetch(`/api/agent/mail/${alpha.connectionId}/mailboxes/alpha%40mail.test/messages`, readToken))
				.status,
		).toBe(200);

		// A grant on alpha does not reach beta.
		expect(
			(await agentFetch(`/api/agent/mail/${alpha.connectionId}/mailboxes/beta%40mail.test/messages`, readToken))
				.status,
		).toBe(403);

		// Read is not write.
		expect(
			(await agentFetch(`/api/agent/mail/${alpha.connectionId}/messages/${messageId}`, readToken, { method: 'DELETE' }))
				.status,
		).toBe(403);

		await enableAccess(cookie, alpha, 'write');
		const writeToken = await createKey(cookie, alpha.connectionId, 'alpha@mail.test', 'write');
		expect(
			(await agentFetch(`/api/agent/mail/${alpha.connectionId}/messages/${messageId}`, writeToken, { method: 'DELETE' }))
				.status,
		).toBe(200);

		// beta was never granted, so the key cannot address it even at write.
		expect(
			(await agentFetch(`/api/agent/mail/${alpha.connectionId}/mailboxes/beta%40mail.test/messages`, writeToken))
				.status,
		).toBe(403);
	});

	it('publishes mail in the catalog and scopes the reachable mailboxes', async () => {
		const { cookie } = await signUp('alice');
		const mailbox = await createMailbox(cookie, 'catalog@mail.test');
		await enableAccess(cookie, mailbox, 'read');
		await deliver(rawEmail({ to: 'catalog@mail.test', subject: 'Hello' }), 'catalog@mail.test');

		const token = await createKey(cookie, mailbox.connectionId, '*', 'read');
		const catalog = await SELF.fetch(url('/api/agent'), { headers: { authorization: `Bearer ${token}` } });
		const body = (await catalog.json()) as {
			data: {
				services: { type: string; docsUrl: string }[];
				connections: { provider: string; resources: { resourceKey: string; access: string }[] }[];
			};
		};

		expect(body.data.services.map((service) => service.type)).toContain('mail');
		expect(body.data.services.find((service) => service.type === 'mail')?.docsUrl).toBe('/docs/agent/mail.html');

		const connection = body.data.connections.find((entry) => entry.provider === 'mail');
		expect(connection?.resources.find((resource) => resource.resourceKey === 'catalog@mail.test')?.access).toBe(
			'read',
		);

		const mailboxes = await agentFetch(`/api/agent/mail/${mailbox.connectionId}/`, token);
		expect(mailboxes.status).toBe(200);
		const listed = (await mailboxes.json()) as { data: { mailboxes: { address: string; maxAccess: string }[] } };
		expect(listed.data.mailboxes.map((entry) => entry.address)).toContain('catalog@mail.test');
	});

	it('deletes a mailbox with its messages and its connection resource', async () => {
		const { cookie } = await signUp('alice');
		const mailbox = await createMailbox(cookie, 'gone@mail.test');
		await deliver(rawEmail({ to: 'gone@mail.test', subject: 'Delete me' }), 'gone@mail.test');

		await adminOk(cookie, '/api/admin/mail/mailboxes/gone%40mail.test', { method: 'DELETE' });

		const messages = await testEnv.DB.prepare(
			'SELECT COUNT(*) AS count FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE mb.address = ?',
		)
			.bind('gone@mail.test')
			.first<{ count: number }>();
		expect(messages?.count).toBe(0);

		const resource = await testEnv.DB.prepare(
			'SELECT COUNT(*) AS count FROM connection_resources WHERE resource_key = ?',
		)
			.bind('gone@mail.test')
			.first<{ count: number }>();
		expect(resource?.count).toBe(0);

		const after = await adminJson<{ error: { code: string } }>(cookie, '/api/admin/mail/mailboxes/gone%40mail.test');
		expect(after.status).toBe(404);
	});

	it('enforces reject_new quotas and spills large attachments to KV', async () => {
		const { cookie } = await signUp('alice');
		await createMailbox(cookie, 'full@mail.test', { quotaMessages: 1, overflow: 'reject_new' });
		expect(await deliver(rawEmail({ to: 'full@mail.test', subject: 'First' }), 'full@mail.test')).toBeNull();
		await expect(deliver(rawEmail({ to: 'full@mail.test', subject: 'Second' }), 'full@mail.test')).rejects.toThrow(
			'Mailbox is full',
		);

		await createMailbox(cookie, 'big@mail.test');
		const content = 'x'.repeat(1_200_000);
		expect(
			await deliver(
				rawEmail({
					to: 'big@mail.test',
					subject: 'Large attachment',
					attachment: { filename: 'big.txt', content },
				}),
				'big@mail.test',
			),
		).toBeNull();

		const listed = await adminOk<MessageListPayload>(
			cookie,
			'/api/admin/mail/mailboxes/big%40mail.test/messages',
		);
		const detail = await adminOk<MessagePayload>(
			cookie,
			`/api/admin/mail/messages/${listed.data.messages[0]!.id}`,
		);
		const attachment = detail.data.message.attachments[0]!;
		expect(attachment.storage).toBe('kv');
		expect(attachment.sizeBytes).toBeGreaterThanOrEqual(content.length);

		const stored = await testEnv.DB.prepare('SELECT kv_key FROM attachments WHERE id = ?')
			.bind(attachment.id)
			.first<{ kv_key: string | null }>();
		expect(stored?.kv_key).toBeTruthy();
		const fromKv = await testEnv.ATTACHMENTS.get(stored!.kv_key!);
		expect(fromKv?.length).toBe(attachment.sizeBytes);

		const download = await SELF.fetch(url(attachment.url), { headers: { cookie } });
		expect(download.status).toBe(200);
		expect((await download.arrayBuffer()).byteLength).toBe(attachment.sizeBytes);
	});
});
