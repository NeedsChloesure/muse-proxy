import { useState, type FormEvent } from 'react';

import { Alert, Field, useAsync } from '../components';
import { api, errorMessage, type Account } from '../lib/api';

export function SettingsPage({ account }: { account: Account }) {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	return (
		<>
			<h1>Settings</h1>
			<p className="lead">
				Signed in as <code>{account.username}</code>
				{account.isAdmin ? ' (administrator)' : ''}.
			</p>

			<Alert>{error}</Alert>
			<Alert kind="ok">{notice}</Alert>

			<div className="panel">
				<h2>Change password</h2>
				<p className="hint">Changing your password signs out every other session.</p>
				<form
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						setBusy(true);
						setError(null);
						setNotice(null);
						void api
							.changePassword(current, next)
							.then(() => {
								setCurrent('');
								setNext('');
								setNotice('Password changed.');
							})
							.catch((cause: unknown) => setError(errorMessage(cause)))
							.finally(() => setBusy(false));
					}}
				>
					<div className="grid">
						<Field label="Current password">
							<input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
						</Field>
						<Field label="New password" hint="At least 10 characters.">
							<input
								type="password"
								value={next}
								onChange={(event) => setNext(event.target.value)}
								required
								minLength={10}
							/>
						</Field>
					</div>
					<div className="row" style={{ marginTop: '1rem' }}>
						<button type="submit" disabled={busy}>
							Change password
						</button>
					</div>
				</form>
			</div>

			{account.isAdmin ? <AccountsPanel /> : null}

			<div className="panel">
				<h2>For agents</h2>
				<p className="hint">Point agents at the catalog and let them read the docs for their service.</p>
				<pre>{`GET /api/agent
GET /api/agent/openapi.json
GET /api/agent/notices
/docs/`}</pre>
			</div>
		</>
	);
}

function AccountsPanel() {
	const [reloadKey, setReloadKey] = useState(0);
	// The dependency is what makes the list reload after a mutation. Without it
	// the fetch happens once on mount, so an account that was just added or
	// toggled never appears until the page is reloaded.
	const accounts = useAsync(() => api.accounts.list(), [reloadKey]);
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [isAdmin, setIsAdmin] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const list = accounts.data?.accounts ?? [];

	return (
		<div className="panel">
			<h2>Accounts</h2>
			<p className="hint">
				Administrators can add accounts even when public signup is switched off, which is how a self-hosted deployment is
				managed.
			</p>

			<Alert>{error ?? accounts.error}</Alert>

			<table>
				<thead>
					<tr>
						<th>Username</th>
						<th>Role</th>
						<th>Status</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{list.map((entry) => (
						<tr key={entry.id}>
							<td>{entry.username}</td>
							<td>
								<button
									className="link"
									disabled={busy}
									onClick={() => {
										setBusy(true);
										void api.accounts
											.update(entry.id, { isAdmin: !entry.isAdmin })
											.catch((cause: unknown) => setError(errorMessage(cause)))
											.finally(() => {
												setBusy(false);
												setReloadKey((value) => value + 1);
											});
									}}
								>
									{entry.isAdmin ? 'admin' : 'member'}
								</button>
							</td>
							<td>
								{entry.disabledAt ? <span className="pill bad">disabled</span> : <span className="pill ok">active</span>}
							</td>
							<td style={{ textAlign: 'right' }}>
								<button
									className="link"
									disabled={busy}
									onClick={() => {
										setBusy(true);
										void api.accounts
											.update(entry.id, { disabled: !entry.disabledAt })
											.catch((cause: unknown) => setError(errorMessage(cause)))
											.finally(() => {
												setBusy(false);
												setReloadKey((value) => value + 1);
											});
									}}
								>
									{entry.disabledAt ? 'Enable' : 'Disable'}
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<form
				style={{ marginTop: '1rem' }}
				onSubmit={(event: FormEvent) => {
					event.preventDefault();
					setBusy(true);
					setError(null);
					void api.accounts
						.create({ username, password, isAdmin })
						.then(() => {
							setUsername('');
							setPassword('');
							setIsAdmin(false);
							setReloadKey((value) => value + 1);
						})
						.catch((cause: unknown) => setError(errorMessage(cause)))
						.finally(() => setBusy(false));
				}}
			>
				<h3>Add an account</h3>
				<div className="grid">
					<Field label="Username">
						<input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} />
					</Field>
					<Field label="Password">
						<input
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							required
							minLength={10}
						/>
					</Field>
				</div>
				<div className="row" style={{ marginTop: '0.75rem' }}>
					<label style={{ margin: 0 }}>
						<input
							type="checkbox"
							style={{ width: 'auto', marginRight: '0.4rem' }}
							checked={isAdmin}
							onChange={(event) => setIsAdmin(event.target.checked)}
						/>
						Administrator
					</label>
				</div>
				<div className="row" style={{ marginTop: '0.75rem' }}>
					<button type="submit" disabled={busy}>
						Add account
					</button>
				</div>
			</form>
		</div>
	);
}

