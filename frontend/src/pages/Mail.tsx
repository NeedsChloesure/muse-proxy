import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Alert, Field, StatusPill, relativeTime, useAsync } from '../components';
import {
	api,
	errorMessage,
	type Access,
	type MailMessage,
	type MailMessageDetail,
	type Mailbox,
	type MailOverflow,
} from '../lib/api';

const LEVELS: Access[] = ['none', 'read', 'write'];
const PAGE_SIZE = 25;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string | null): string {
	if (!value) return '—';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function quotaLabel(mailbox: Mailbox): string {
	const bytes = mailbox.quotaBytes > 0 ? ` of ${formatBytes(mailbox.quotaBytes)}` : '';
	const messages = mailbox.quotaMessages > 0 ? ` · ${mailbox.usedMessages}/${mailbox.quotaMessages}` : '';
	return `${formatBytes(mailbox.usedBytes)}${bytes}${messages}`;
}

function MailboxLink({ address, children }: { address: string; children?: ReactNode }) {
	return <Link to={`/mail/mailboxes/${encodeURIComponent(address)}`}>{children ?? address}</Link>;
}

/* -------------------------------------------------------------------------- */
/* Mailboxes                                                                  */
/* -------------------------------------------------------------------------- */

export function MailPage() {
	const listed = useAsync(() => api.mail.list(), []);
	const [address, setAddress] = useState('');
	const [displayName, setDisplayName] = useState('');
	const [quotaMb, setQuotaMb] = useState('0');
	const [quotaMessages, setQuotaMessages] = useState('0');
	const [overflow, setOverflow] = useState<MailOverflow>('trim_oldest');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const mailboxes = listed.data?.mailboxes ?? [];

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await api.mail.createMailbox({
				address,
				displayName: displayName.trim() || null,
				quotaBytes: Math.round(Math.max(0, Number(quotaMb) || 0) * 1_048_576),
				quotaMessages: Math.max(0, Math.floor(Number(quotaMessages) || 0)),
				overflow,
			});
			setAddress('');
			setDisplayName('');
			setQuotaMb('0');
			setQuotaMessages('0');
			setNotice('Mailbox added. Add a matching Cloudflare Email Routing rule that sends it to this Worker.');
			listed.reload();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<div className="between">
				<div>
					<h1>Mail</h1>
					<p className="lead">
						Inbound addresses hosted by this Worker. Each mailbox is a scoped resource: enable a ceiling here and grant it to a key
						like any other connection.
					</p>
				</div>
			</div>

			<Alert>{error ?? listed.error}</Alert>
			<Alert kind="ok">{notice}</Alert>

			<div className="panel">
				<h2>Addresses</h2>
				<p className="hint">
					Mail for an address is only accepted once a Cloudflare Email Routing rule sends that address to this Worker. Unknown or
					disabled addresses are rejected at delivery.
				</p>

				{listed.loading ? (
					<p className="muted">Loading…</p>
				) : mailboxes.length === 0 ? (
					<p className="muted">No mailboxes yet. Add one below.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Address</th>
								<th>Status</th>
								<th>Storage</th>
								<th>Agent access</th>
								<th>Last received</th>
							</tr>
						</thead>
						<tbody>
							{mailboxes.map((mailbox) => (
								<tr key={mailbox.id}>
									<td>
										<div>
											<MailboxLink address={mailbox.address}>
												{mailbox.displayName || mailbox.address}
											</MailboxLink>
										</div>
										<div className="muted mono">{mailbox.address}</div>
									</td>
									<td>
										<span className={`pill ${mailbox.enabled ? 'ok' : 'muted'}`}>{mailbox.enabled ? 'active' : 'disabled'}</span>
									</td>
									<td className="muted">{quotaLabel(mailbox)}</td>
									<td>
										<span className={`pill ${mailbox.maxAccess === 'none' ? 'muted' : 'ok'}`}>{mailbox.maxAccess}</span>
									</td>
									<td className="muted">{mailbox.lastReceivedAt ? formatDate(mailbox.lastReceivedAt) : 'never'}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			<form className="panel" onSubmit={submit}>
				<h2>Add an address</h2>
				<div className="grid">
					<Field label="Address" hint="A bare name uses DEFAULT_DOMAIN.">
						<input
							value={address}
							onChange={(event) => setAddress(event.target.value)}
							placeholder="notes@mail.example.com"
							required
						/>
					</Field>
					<Field label="Display name">
						<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Notes" />
					</Field>
					<Field label="Quota (MB)" hint="0 is unlimited.">
						<input type="number" min="0" value={quotaMb} onChange={(event) => setQuotaMb(event.target.value)} />
					</Field>
					<Field label="Quota (messages)" hint="0 is unlimited.">
						<input
							type="number"
							min="0"
							value={quotaMessages}
							onChange={(event) => setQuotaMessages(event.target.value)}
						/>
					</Field>
					<Field label="When full">
						<select value={overflow} onChange={(event) => setOverflow(event.target.value as MailOverflow)}>
							<option value="trim_oldest">Delete the oldest mail</option>
							<option value="reject_new">Refuse new mail</option>
						</select>
					</Field>
				</div>
				<div className="row" style={{ marginTop: '1rem' }}>
					<button className="primary" type="submit" disabled={busy}>
						{busy ? 'Adding…' : 'Add mailbox'}
					</button>
				</div>
			</form>
		</>
	);
}

/* -------------------------------------------------------------------------- */
/* One mailbox                                                                */
/* -------------------------------------------------------------------------- */

export function MailboxPage() {
	const { address = '' } = useParams();
	const navigate = useNavigate();
	const [reloadKey, setReloadKey] = useState(0);
	const loaded = useAsync(() => api.mail.getMailbox(address), [address, reloadKey]);
	const mailbox = loaded.data?.mailbox ?? null;
	const stats = loaded.data?.stats ?? null;

	const [displayName, setDisplayName] = useState('');
	const [enabled, setEnabled] = useState(true);
	const [quotaMb, setQuotaMb] = useState('0');
	const [quotaMessages, setQuotaMessages] = useState('0');
	const [overflow, setOverflow] = useState<MailOverflow>('trim_oldest');
	const [retentionDays, setRetentionDays] = useState('0');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const [messages, setMessages] = useState<MailMessage[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [messagesLoading, setMessagesLoading] = useState(true);
	const [messageError, setMessageError] = useState<string | null>(null);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [attachmentsOnly, setAttachmentsOnly] = useState(false);
	const [query, setQuery] = useState('');

	useEffect(() => {
		if (!mailbox) return;
		setDisplayName(mailbox.displayName ?? '');
		setEnabled(mailbox.enabled);
		setQuotaMb(String(Math.round((mailbox.quotaBytes / 1_048_576) * 10) / 10));
		setQuotaMessages(String(mailbox.quotaMessages));
		setOverflow(mailbox.overflow);
		setRetentionDays(String(mailbox.retentionDays));
	}, [mailbox?.id, mailbox?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		let cancelled = false;
		setMessagesLoading(true);
		setMessageError(null);
		api.mail
			.messages(address, {
				limit: PAGE_SIZE,
				unread: unreadOnly || undefined,
				hasAttachments: attachmentsOnly || undefined,
				q: query.trim() || undefined,
			})
			.then((result) => {
				if (cancelled) return;
				setMessages(result.messages);
				setCursor(result.nextCursor);
				setHasMore(result.hasMore);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setMessageError(errorMessage(cause));
			})
			.finally(() => {
				if (!cancelled) setMessagesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [address, reloadKey, unreadOnly, attachmentsOnly, query]);

	function bump() {
		setReloadKey((value) => value + 1);
	}

	async function run(action: () => Promise<string>) {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			setNotice(await action());
			bump();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		await run(async () => {
			await api.mail.updateMailbox(address, {
				displayName: displayName.trim() || null,
				enabled,
				quotaBytes: Math.round(Math.max(0, Number(quotaMb) || 0) * 1_048_576),
				quotaMessages: Math.max(0, Math.floor(Number(quotaMessages) || 0)),
				overflow,
				retentionDays: Math.max(0, Math.floor(Number(retentionDays) || 0)),
			});
			return 'Settings saved.';
		});
	}

	async function loadMore() {
		if (!cursor) return;
		setMessagesLoading(true);
		try {
			const result = await api.mail.messages(address, {
				limit: PAGE_SIZE,
				cursor,
				unread: unreadOnly || undefined,
				hasAttachments: attachmentsOnly || undefined,
				q: query.trim() || undefined,
			});
			setMessages((current) => [...current, ...result.messages]);
			setCursor(result.nextCursor);
			setHasMore(result.hasMore);
		} catch (cause) {
			setMessageError(errorMessage(cause));
		} finally {
			setMessagesLoading(false);
		}
	}

	if (loaded.loading) return <p className="muted">Loading…</p>;
	if (!mailbox) {
		return (
			<>
				<Alert>{loaded.error ?? 'No such mailbox.'}</Alert>
				<Link to="/mail">
					<button>Back to Mail</button>
				</Link>
			</>
		);
	}

	return (
		<>
			<Link to="/mail" className="muted">
				← Mail
			</Link>
			<div className="between" style={{ marginTop: '0.5rem' }}>
				<div>
					<h1>
						{mailbox.displayName || mailbox.address}{' '}
						<span className={`pill ${mailbox.enabled ? 'ok' : 'muted'}`}>{mailbox.enabled ? 'active' : 'disabled'}</span>
					</h1>
					<div className="muted mono">{mailbox.address}</div>
				</div>
				<button
					className="danger"
					disabled={busy}
					onClick={() => {
						if (!window.confirm(`Delete ${mailbox.address} and all of its mail?`)) return;
						void run(async () => {
							const result = await api.mail.deleteMailbox(mailbox.address);
							navigate('/mail');
							return `Deleted ${result.deletedMessages} message(s).`;
						});
					}}
				>
					Delete mailbox
				</button>
			</div>

			<Alert>{error ?? loaded.error}</Alert>
			<Alert kind="ok">{notice}</Alert>

			{stats ? (
				<div className="panel">
					<div className="row" style={{ justifyContent: 'space-between' }}>
						<div>
							<strong>{stats.messages.toLocaleString()}</strong> messages, <strong>{stats.unread.toLocaleString()}</strong> unread
						</div>
						<div className="muted">
							{formatBytes(stats.bytes)} stored
							{stats.attachments.length > 0
								? ` · ${stats.attachments
										.map(
											(entry) =>
												`${entry.count.toLocaleString()} attachment${entry.count === 1 ? '' : 's'} in ${entry.storage.toUpperCase()}`,
										)
										.join(' · ')}`
								: ''}
						</div>
					</div>
					<p className="hint">
						{stats.oldestAt ? `Oldest ${formatDate(stats.oldestAt)}` : 'No mail yet'}
						{stats.newestAt ? ` · newest ${formatDate(stats.newestAt)}` : ''}
					</p>
				</div>
			) : null}

			<div className="panel">
				<div className="between">
					<div>
						<h2 style={{ margin: 0 }}>Agent access</h2>
						<p className="hint">
							The connection ceiling for this mailbox. A key still needs its own grant, and cannot exceed this.
						</p>
					</div>
					<select
						style={{ width: 'auto' }}
						value={mailbox.maxAccess}
						disabled={busy || !mailbox.resourceId}
						onChange={(event) => {
							if (!mailbox.resourceId) return;
							void run(async () => {
								await api.connections.setResourceAccess(
									mailbox.connectionId,
									mailbox.resourceId as string,
									event.target.value as Access,
								);
								return 'Agent access updated.';
							});
						}}
					>
						{LEVELS.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</div>
			</div>

			<form className="panel" onSubmit={save}>
				<h2>Settings</h2>
				<div className="grid">
					<Field label="Display name">
						<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
					</Field>
					<Field label="Status">
						<select value={enabled ? '1' : '0'} onChange={(event) => setEnabled(event.target.value === '1')}>
							<option value="1">Accept mail</option>
							<option value="0">Disabled</option>
						</select>
					</Field>
					<Field label="Quota (MB)" hint="0 is unlimited.">
						<input type="number" min="0" value={quotaMb} onChange={(event) => setQuotaMb(event.target.value)} />
					</Field>
					<Field label="Quota (messages)" hint="0 is unlimited.">
						<input
							type="number"
							min="0"
							value={quotaMessages}
							onChange={(event) => setQuotaMessages(event.target.value)}
						/>
					</Field>
					<Field label="When full">
						<select value={overflow} onChange={(event) => setOverflow(event.target.value as MailOverflow)}>
							<option value="trim_oldest">Delete the oldest mail</option>
							<option value="reject_new">Refuse new mail</option>
						</select>
					</Field>
					<Field label="Retention (days)" hint="Stored for future use; trim and purge are the active controls.">
						<input
							type="number"
							min="0"
							value={retentionDays}
							onChange={(event) => setRetentionDays(event.target.value)}
						/>
					</Field>
				</div>
				<div className="row" style={{ marginTop: '1rem' }}>
					<button className="primary" type="submit" disabled={busy}>
						Save
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const result = await api.mail.trim(mailbox.address);
								return result.deleted === 0
									? 'Mailbox already fits its quota.'
									: `Deleted ${result.deleted} message(s)${result.withinQuota ? '' : '; still above quota'}.`;
							})
						}
					>
						Trim to quota
					</button>
					<button
						type="button"
						className="danger"
						disabled={busy}
						onClick={() => {
							if (!window.confirm(`Delete every message in ${mailbox.address}?`)) return;
							void run(async () => {
								const result = await api.mail.purge(mailbox.address, { all: true });
								return `Deleted ${result.deleted} message(s)${result.hasMore ? '; more remain' : ''}.`;
							});
						}}
					>
						Purge all
					</button>
				</div>
			</form>

			<div className="panel">
				<div className="between">
					<h2 style={{ margin: 0 }}>Messages</h2>
					<div className="row">
						<label className="mail-filter">
							<input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} /> unread
						</label>
						<label className="mail-filter">
							<input
								type="checkbox"
								checked={attachmentsOnly}
								onChange={(event) => setAttachmentsOnly(event.target.checked)}
							/>{' '}
							attachments
						</label>
						<input
							style={{ width: '14rem' }}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search subject or sender"
						/>
					</div>
				</div>

				<Alert>{messageError}</Alert>

				{messagesLoading && messages.length === 0 ? (
					<p className="muted">Loading…</p>
				) : messages.length === 0 ? (
					<p className="muted">No messages match.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>From</th>
								<th>Subject</th>
								<th>Received</th>
								<th>Size</th>
							</tr>
						</thead>
						<tbody>
							{messages.map((message) => (
								<tr key={message.id} className={message.isRead ? undefined : 'mail-unread'}>
									<td>
										<div>{message.from.name || message.from.address || '(unknown)'}</div>
										<div className="muted mono">{message.from.address}</div>
									</td>
									<td>
										<Link to={`/mail/messages/${message.id}`}>{message.subject || '(no subject)'}</Link>
										{message.isStarred ? <span className="pill warn" style={{ marginLeft: '0.4rem' }}>star</span> : null}
										{message.hasAttachments ? (
											<span className="pill muted" style={{ marginLeft: '0.4rem' }}>
												{message.attachmentCount} file{message.attachmentCount === 1 ? '' : 's'}
											</span>
										) : null}
										<div className="muted mail-preview">{message.preview}</div>
									</td>
									<td className="muted nowrap">{formatDate(message.receivedAt)}</td>
									<td className="muted nowrap">{formatBytes(message.sizeBytes)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}

				{hasMore ? (
					<div className="row" style={{ marginTop: '0.75rem' }}>
						<button type="button" disabled={messagesLoading} onClick={() => void loadMore()}>
							{messagesLoading ? 'Loading…' : 'Load more'}
						</button>
					</div>
				) : null}
			</div>
		</>
	);
}

/* -------------------------------------------------------------------------- */
/* One message                                                                */
/* -------------------------------------------------------------------------- */

export function MessagePage() {
	const { id = '' } = useParams();
	const navigate = useNavigate();
	const [reloadKey, setReloadKey] = useState(0);
	const loaded = useAsync(() => api.mail.getMessage(id), [id, reloadKey]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [showHtml, setShowHtml] = useState(false);

	const message: MailMessageDetail | null = loaded.data?.message ?? null;

	async function update(input: { isRead?: boolean; isStarred?: boolean }) {
		setBusy(true);
		setError(null);
		try {
			await api.mail.updateMessage(id, input);
			setReloadKey((value) => value + 1);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	if (loaded.loading) return <p className="muted">Loading…</p>;
	if (!message) {
		return (
			<>
				<Alert>{loaded.error ?? 'No such message.'}</Alert>
				<Link to="/mail">
					<button>Back to Mail</button>
				</Link>
			</>
		);
	}

	return (
		<>
			<Link to={`/mail/mailboxes/${encodeURIComponent(message.mailbox)}`} className="muted">
				← {message.mailbox}
			</Link>
			<div className="between" style={{ marginTop: '0.5rem' }}>
				<h1>{message.subject || '(no subject)'}</h1>
				<div className="row">
					<button type="button" disabled={busy} onClick={() => void update({ isRead: !message.isRead })}>
						{message.isRead ? 'Mark unread' : 'Mark read'}
					</button>
					<button type="button" disabled={busy} onClick={() => void update({ isStarred: !message.isStarred })}>
						{message.isStarred ? 'Unstar' : 'Star'}
					</button>
					<button
						type="button"
						className="danger"
						disabled={busy}
						onClick={() => {
							if (!window.confirm('Delete this message?')) return;
							void (async () => {
								try {
									await api.mail.deleteMessage(message.id);
									navigate(`/mail/mailboxes/${encodeURIComponent(message.mailbox)}`);
								} catch (cause) {
									setError(errorMessage(cause));
								}
							})();
						}}
					>
						Delete
					</button>
				</div>
			</div>

			<Alert>{error ?? loaded.error}</Alert>
			{message.parseError ? <Alert kind="warn">Parse error: {message.parseError}</Alert> : null}

			<div className="panel">
				<div className="grid">
					<div>
						<label>From</label>
						<div>{message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address}</div>
					</div>
					<div>
						<label>To</label>
						<div>{message.to.map((entry) => entry.address).join(', ') || '—'}</div>
					</div>
					<div>
						<label>Received</label>
						<div>{formatDate(message.receivedAt)}</div>
					</div>
					<div>
						<label>Size</label>
						<div>
							{formatBytes(message.sizeBytes)} raw · {relativeTime(new Date(message.receivedAt).getTime())}
						</div>
					</div>
				</div>
				{message.cc.length > 0 ? (
					<p className="hint">Cc: {message.cc.map((entry) => entry.address).join(', ')}</p>
				) : null}
			</div>

			<div className="panel">
				<div className="between">
					<div className="row">
						<button type="button" onClick={() => setShowHtml(false)} disabled={!showHtml}>
							Plain text
						</button>
						<button type="button" onClick={() => setShowHtml(true)} disabled={showHtml || !message.html}>
							HTML source
						</button>
					</div>
					<div className="row">
						{message.rawAvailable ? <a href={message.rawUrl}>Download .eml</a> : <span className="muted">Raw source not retained</span>}
					</div>
				</div>
				<p className="hint">
					HTML is shown as source. It is never rendered, because mail HTML is untrusted.
					{message.bodyTruncated ? ' This body was truncated at the configured limit.' : ''}
				</p>
				{showHtml ? (
					<pre className="mail-body">{message.html || '(no HTML part)'}</pre>
				) : (
					<pre className="mail-body">{message.text || '(no text part)'}</pre>
				)}
			</div>

			{message.attachments.length > 0 ? (
				<div className="panel">
					<h2>Attachments</h2>
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Type</th>
								<th>Size</th>
								<th>Storage</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{message.attachments.map((attachment) => (
								<tr key={attachment.id}>
									<td>{attachment.filename ?? attachment.id}</td>
									<td className="muted mono">{attachment.mimeType}</td>
									<td className="muted">{formatBytes(attachment.sizeBytes)}</td>
									<td>
										<span className={`pill ${attachment.available ? 'ok' : 'bad'}`}>{attachment.storage}</span>
									</td>
									<td style={{ textAlign: 'right' }}>
										{attachment.available ? <a href={attachment.url}>Download</a> : <span className="muted">unavailable</span>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}

			<details className="panel">
				<summary>Headers ({message.headers.length})</summary>
				<pre className="mail-body">
					{message.headers.map((header) => `${header.key}: ${header.value}`).join('\n') || 'No headers retained.'}
				</pre>
			</details>
		</>
	);
}
