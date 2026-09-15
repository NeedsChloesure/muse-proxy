import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Alert, Field, StatusPill, relativeTime, useAsync } from '../components';
import { api, configSummary, errorMessage, type Access, type Connection, type ProviderField } from '../lib/api';

const LEVELS: Access[] = ['none', 'read', 'write'];

/**
 * One connection: verify it works, set the ceiling for each collection, and see
 * exactly how an agent would address it.
 */
export function ConnectionDetail() {
	const { id = '' } = useParams();
	const navigate = useNavigate();
	const [reloadKey, setReloadKey] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const [manualPath, setManualPath] = useState('');
	const [editLabel, setEditLabel] = useState<string | null>(null);
	const [editConfig, setEditConfig] = useState<Record<string, string> | null>(null);
	const [editUsername, setEditUsername] = useState<string | null>(null);
	const [editSecret, setEditSecret] = useState('');

	const loaded = useAsync(() => api.connections.get(id), [id, reloadKey]);
	const meta = useAsync(() => api.meta(), []);
	const connection: Connection | null = loaded.data?.connection ?? null;

	// The provider declares its own config fields and credential labels, so this
	// page has no idea what a "server URL" is.
	const providerInfo = meta.data?.providers.find((entry) => entry.type === connection?.provider);
	const fields: readonly ProviderField[] = providerInfo?.fields ?? [];
	const credentials = providerInfo?.credentials ?? { usernameLabel: 'Username', secretLabel: 'Password', usernameRequired: true };

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

	if (loaded.loading) return <p className="muted">Loading…</p>;
	if (!connection) {
		return (
			<>
				<Alert>{loaded.error ?? 'No such connection.'}</Alert>
				<Link to="/">
					<button>Back to connections</button>
				</Link>
			</>
		);
	}

	const enabled = connection.resources.filter((resource) => resource.maxAccess !== 'none').length;
	const mount = `/api/agent/${connection.provider}/${connection.id}/`;

	return (
		<>
			<Link to="/" className="muted">
				← Connections
			</Link>
			<div className="between" style={{ marginTop: '0.5rem' }}>
				<div>
					<h1>
						{connection.label} <StatusPill status={connection.status} />
					</h1>
					<div className="muted mono">{configSummary(connection.config, fields)}</div>
				</div>
				<button
					className="danger"
					disabled={busy}
					onClick={() => {
						if (!window.confirm(`Delete '${connection.label}'? Agents using it will lose access and be told.`)) return;
						void run(async () => {
							await api.connections.remove(connection.id);
							navigate('/');
						});
					}}
				>
					Delete
				</button>
			</div>

			<Alert>{error}</Alert>
			<Alert kind="ok">{notice}</Alert>
			{connection.lastError ? <Alert kind="warn">Last error: {connection.lastError}</Alert> : null}

			<div className="panel">
				<div className="row">
					<button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const result = await api.connections.test(connection.id);
								return { message: result.test.ok ? 'Credentials verified.' : `Failed: ${result.test.error}` };
							})
						}
					>
						Test credentials
					</button>
					<button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const result = await api.connections.discover(connection.id);
								return { message: `Discovery found ${result.connection.resources.length} resource(s).` };
							})
						}
					>
						Run discovery
					</button>
					<span className="muted">
						Signed in as <code>{connection.username ?? connection.authType}</code> with {connection.secretHint} · updated{' '}
						{relativeTime(connection.updatedAt)}
					</span>
				</div>
			</div>

			<div className="panel">
				<h2>What agents may do</h2>
				<p className="hint">
					This is the ceiling for the whole connection. A key can be narrower than this, never wider, and{' '}
					{enabled} of {connection.resources.length} resources are currently enabled.
				</p>

				{connection.resources.length === 0 ? (
					<p className="muted">
						No resources discovered. Run discovery, or add one by path below if your server reports them unusually.
					</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Collection</th>
								<th>Type</th>
								<th>Access</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{connection.resources.map((resource) => (
								<tr key={resource.id}>
									<td>
										<div>{resource.displayName ?? resource.resourceKey}</div>
										<div className="muted mono">{resource.resourceKey}</div>
									</td>
									<td className="muted">{resource.kind}</td>
									<td>
										<select
											value={resource.maxAccess}
											disabled={busy}
											onChange={(event) =>
												void run(() => api.connections.setResourceAccess(connection.id, resource.id, event.target.value as Access))
											}
										>
											{LEVELS.map((level) => (
												<option key={level} value={level}>
													{level}
												</option>
											))}
										</select>
									</td>
									<td style={{ textAlign: 'right' }}>
										<button
											className="link"
											disabled={busy}
											onClick={() => void run(() => api.connections.removeResource(connection.id, resource.id))}
										>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}

				<form
					className="row"
					style={{ marginTop: '1rem' }}
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						if (!manualPath.trim()) return;
						void run(async () => {
							await api.connections.addResource(connection.id, { resourceKey: manualPath });
							setManualPath('');
							return { message: 'Collection added. It starts with no access.' };
						});
					}}
				>
					<div style={{ flex: '1 1 20rem' }}>
						<label>Add a collection by path</label>
						<input
							value={manualPath}
							onChange={(event) => setManualPath(event.target.value)}
							placeholder="calendars/alice/work"
						/>
					</div>
					<button type="submit" disabled={busy}>
						Add
					</button>
				</form>
			</div>

			<div className="panel">
				<h2 id="credentials">Credentials</h2>
				<p className="hint">Changing any of these re-verifies against the server and tells the agents using this connection.</p>
				<form
					onSubmit={(event: FormEvent) => {
						event.preventDefault();							const payload: Record<string, unknown> = {};
							if (editLabel !== null) payload.label = editLabel;
							if (editConfig !== null) {
								// Send every declared field, not only the one that was edited. The
								// server validates a config as a whole, so a partial object would
								// drop — or silently default — the fields the user never touched.
								payload.config = Object.fromEntries(
									fields.map((field) => [
										field.name,
										editConfig[field.name] ?? String(connection.config[field.name] ?? ''),
									]),
								);
							}
							if (editUsername !== null) payload.username = editUsername;
							if (editSecret) payload.secret = editSecret;
							void run(async () => {
								await api.connections.update(connection.id, payload);
								setEditLabel(null);
								setEditConfig(null);
								setEditUsername(null);
								setEditSecret('');
								return { message: 'Saved.' };
							});
						}}
					>
						<div className="grid">
							<Field label="Label">
								<input value={editLabel ?? connection.label} onChange={(event) => setEditLabel(event.target.value)} />
							</Field>
							{credentials.usernameRequired || connection.username ? (
								<Field label={credentials.usernameLabel}>
									<input
										value={editUsername ?? connection.username ?? ''}
										onChange={(event) => setEditUsername(event.target.value)}
									/>
								</Field>
							) : null}
						</div>
						{fields.map((field) => (
							<div key={field.name}>
								<div style={{ height: '0.75rem' }} />
								<Field label={field.label} hint={field.help}>
									<input
										value={editConfig?.[field.name] ?? String(connection.config[field.name] ?? '')}
										onChange={(event) => setEditConfig({ ...(editConfig ?? {}), [field.name]: event.target.value })}
									/>
								</Field>
							</div>
						))}
						<div style={{ height: '0.75rem' }} />
						<Field label={`New ${credentials.secretLabel.toLowerCase()}`} hint="Leave blank to keep the stored password.">
							<input type="password" value={editSecret} onChange={(event) => setEditSecret(event.target.value)} />
						</Field>
					<div className="row" style={{ marginTop: '1rem' }}>
						<button type="submit" disabled={busy}>
							Save
						</button>
					</div>
				</form>
			</div>

			<div className="panel">
				<h2>Agent endpoint</h2>
				<p className="hint">Give an agent the mount path and one of your API keys. It never sees the credentials above.</p>
				<pre>{`PROPFIND ${mount}
# or, from the outside:
curl -X PROPFIND -H "Depth: 1" -H "Authorization: Bearer muse_..." \\
  ${typeof window === 'undefined' ? '' : window.location.origin}${mount}`}</pre>
			</div>
		</>
	);
}
