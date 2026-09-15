import { useState, type FormEvent } from 'react';

import { Alert, Field } from '../components';
import { api, errorMessage, type Account, type Meta } from '../lib/api';

/**
 * Sign-in and account creation. The first account on a fresh deployment can
 * always be created, even when signup is switched off, so a locked-down
 * deployment can still be bootstrapped.
 */
export function AuthScreen({ meta, onAuthed }: { meta: Meta | null; onAuthed: (account: Account) => void }) {
	const firstRun = meta !== null && !meta.hasAccounts;
	const signupEnabled = meta?.signupEnabled ?? true;

	// Null until the visitor picks a mode themselves. Until then the mode is
	// derived, so the first account is offered as soon as the metadata arrives
	// instead of racing it: /meta and /me resolve in parallel, and a fixed
	// initial state would show "Sign in" on a deployment with no accounts.
	const [chosenMode, setChosenMode] = useState<'login' | 'signup' | null>(null);
	const mode = chosenMode ?? (firstRun ? 'signup' : 'login');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const result = mode === 'login' ? await api.login(username, password) : await api.signup(username, password);
			onAuthed(result.account);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="panel">
			<h1>{mode === 'login' ? 'Sign in' : firstRun ? 'Create the first account' : 'Create an account'}</h1>
			<p className="lead">
				{firstRun
					? 'No accounts exist yet. The first one becomes the administrator.'
					: 'Give agents scoped API keys instead of your passwords.'}
			</p>

			<Alert>{error}</Alert>

			<form onSubmit={submit}>
				<Field label="Username">
					<input
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						required
						minLength={3}
					/>
				</Field>

				<div style={{ height: '0.75rem' }} />

				<Field label="Password" hint={mode === 'signup' ? 'At least 10 characters.' : undefined}>
					<input
						type="password"
						autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						required
						minLength={mode === 'signup' ? 10 : 1}
					/>
				</Field>

				<div className="row" style={{ marginTop: '1rem' }}>
					<button className="primary" type="submit" disabled={busy}>
						{busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
					</button>
					{signupEnabled || firstRun ? (
						<button
							type="button"
							className="link"
							onClick={() => {
								setChosenMode(mode === 'login' ? 'signup' : 'login');
								setError(null);
							}}
						>
							{mode === 'login' ? 'Create an account' : 'I already have an account'}
						</button>
					) : null}
				</div>
			</form>
		</div>
	);
}
