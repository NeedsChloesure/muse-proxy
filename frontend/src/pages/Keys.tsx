import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Alert, Field, ScopeMatrix, TokenReveal, relativeTime, useAsync } from '../components';
import { api, errorMessage, type Connection, type Grant } from '../lib/api';
import { usageDisplay } from '../lib/keyActivity';

export function KeysPage() {
	const connections = useAsync(() => api.connections.list(), []);
	const keys = useAsync(() => api.keys.list(), []);
	const [reloadKey, setReloadKey] = useState(0);

	const [name, setName] = useState('');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [grants, setGrants] = useState<Grant[]>([]);
	const [token, setToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const connectionList: Connection[] = connections.data?.connections ?? [];
	const keyList = keys.data?.keys ?? [];
	// Usage states are computed once per render: an expired key that was in use
	// when it died gets a loud "recently active" pill next to its expired one.
	const usageByKey = new Map(keyList.map((key) => [key.id, usageDisplay(key, Date.now(), relativeTime)]));

	async function remove(keyId: string) {
		if (!window.confirm('Delete this key permanently? Agents using it stop working immediately, and its grants and unread notices go with it.')) return;
		setBusy(true);
		setError(null);
		try {
			await api.keys.remove(keyId);
			setReloadKey((value) => value + 1);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	async function create(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const result = await api.keys.create({
				name,
				expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
				grants,
			});
			setToken(result.token);
			setName('');
			setExpiresInDays('');
			setGrants([]);
			setReloadKey((value) => value + 1);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	const tokenMount = grants.length > 0 ? mountFor(connectionList, grants[0].connectionId) : undefined;

	return (
		<>
			<h1>API keys</h1>
			<p className="lead">
				Each key is a separate identity for one agent. Grant the least it needs: a read-only key for the assistant that only
				reads your calendar, a write key for the one that books things.
			</p>

			<Alert>{error}</Alert>

			{token ? (
				<div className="panel">
					<h2>New key</h2>
					<TokenReveal token={token} mountPath={tokenMount} />
					<div className="row" style={{ marginTop: '0.75rem' }}>
						<button onClick={() => setToken(null)}>Done</button>
					</div>
				</div>
			) : null}

			<div className="panel">
				<h2>Existing keys</h2>
				{keyList.length === 0 ? (
					<p className="muted">No keys yet.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Prefix</th>
								<th>Status</th>
								<th>Last used</th>
								<th>Grants</th>
								<th className="nowrap">Actions</th>
							</tr>
						</thead>
						<tbody>
							{keyList.map((key) => {
								const usage = usageByKey.get(key.id);
								return (
									<tr key={key.id}>
									<td>
										<Link to={`/keys/${key.id}`}>{key.name}</Link>
									</td>
									<td className="mono muted">{key.prefix}…</td>
									<td>
									{key.active ? (
										<span className="pill ok">active</span>
									) : (
										<span className="pill bad">expired</span>
									)}
									{usage?.pill ? <span className={`pill ${usage.pill.tone}`}>{usage.pill.text}</span> : null}
									</td>
									<td className="muted">{usage?.used ?? (key.lastUsedAt ? relativeTime(key.lastUsedAt) : 'never')}</td>
									<td className="muted">									{(key.grants ?? []).length === 0
										? 'none'
										: (key.grants ?? []).map((grant) => (
												<span key={`${grant.connectionId}-${grant.resourceKey}`} className="pill muted">
													{grant.resourceKey === '*' ? 'all' : grant.resourceKey.split('/').pop()} · {grant.maxAccess}
												</span>
											))}
									</td>
									<td>
										<button className="danger" disabled={busy} onClick={() => void remove(key.id)}>
											Delete
										</button>
									</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>

			<form className="panel" onSubmit={create}>
				<h2>Create a key</h2>
				<div className="grid">
					<Field label="Name" hint="For your own reference, so you know which agent holds it.">
						<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Calendar agent" required />
					</Field>
					<Field label="Expires in (days)" hint="Leave blank to never expire.">
						<input
							type="number"
							min={1}
							max={3650}
							value={expiresInDays}
							onChange={(event) => setExpiresInDays(event.target.value)}
						/>
					</Field>
				</div>

				<h3>What may this key reach?</h3>
				<ScopeMatrix connections={connectionList} grants={grants} onChange={setGrants} />

				<div className="row" style={{ marginTop: '1rem' }}>
					<button className="primary" type="submit" disabled={busy || !name.trim()}>
						{busy ? 'Creating…' : 'Create key'}
					</button>
					<span className="hint">The key is shown once, right here.</span>
				</div>
			</form>
		</>
	);
}

export function KeyDetailPage() {
	const { id = '' } = useParams();
	const navigate = useNavigate();
	const [reloadKey, setReloadKey] = useState(0);
	const loaded = useAsync(() => api.keys.get(id), [id, reloadKey]);
	const connections = useAsync(() => api.connections.list(), []);

	const [grants, setGrants] = useState<Grant[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const key = loaded.data?.key ?? null;
	const connectionList = connections.data?.connections ?? [];
	const current = grants ?? loaded.data?.grants ?? [];

	if (loaded.loading) return <p className="muted">Loading…</p>;
	if (!key) {
		return (
			<>
				<Alert>{loaded.error ?? 'No such key.'}</Alert>
				<Link to="/keys">
					<button>Back to keys</button>
				</Link>
			</>
		);
	}

	async function run(action: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await action();
			if (result && typeof result === 'object' && 'message' in result) {
				const message = (result as { message?: unknown }).message;
				if (typeof message === 'string') setNotice(message);
			}
			setReloadKey((value) => value + 1);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<Link to="/keys" className="muted">
				← API keys
			</Link>
			<h1 style={{ marginTop: '0.5rem' }}>{key.name}</h1>
			<p className="lead mono">{key.prefix}…</p>

			<Alert>{error}</Alert>
			<Alert kind="ok">{notice}</Alert>

			<div className="panel">
				<div className="between">
					<div className="muted">
						Created {relativeTime(key.createdAt)} · last used {key.lastUsedAt ? relativeTime(key.lastUsedAt) : 'never'} ·{' '}
						{key.expiresAt ? `expires ${new Date(key.expiresAt).toLocaleDateString()}` : 'no expiry'}
					</div>						<div className="row">
							<button
								className="danger"
								disabled={busy}
								onClick={() => {
									if (!window.confirm('Delete this key permanently? Agents using it stop working immediately, and its grants and unread notices go with it.')) return;
									void run(async () => {
										await api.keys.remove(key.id);
										navigate('/keys');
										return { message: 'Key deleted.' };
									});
								}}
							>
								Delete key
							</button>
						</div>
				</div>
			</div>

			<div className="panel">
				<h2>Grants</h2>
				<p className="hint">
					Narrowing a key notifies it, so the agent can adjust its expectations and tell its human.
				</p>
				<ScopeMatrix connections={connectionList} grants={current} onChange={setGrants} />
				<div className="row" style={{ marginTop: '1rem' }}>
					<button
						className="primary"
						disabled={busy || grants === null}
						onClick={() =>
							void run(async () => {
								await api.keys.setGrants(key.id, current);
								setGrants(null);
								return { message: 'Grants updated.' };
							})
						}
					>
						Save grants
					</button>
					{grants !== null ? (
						<button disabled={busy} onClick={() => setGrants(null)}>
							Discard changes
						</button>
					) : null}
				</div>
			</div>
		</>
	);
}

function mountFor(connections: Connection[], connectionId: string): string | undefined {
	const connection = connections.find((entry) => entry.id === connectionId);
	return connection ? `/api/agent/${connection.provider}/${connection.id}/` : undefined;
}
