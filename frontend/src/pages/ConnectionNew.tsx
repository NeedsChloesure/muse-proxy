import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Field, useAsync } from '../components';
import { api, errorMessage, type Connection, type ProviderField, type TestResult } from '../lib/api';

interface Outcome {
	connection: Connection | null;
	test: TestResult;
	warnings: string[];
}

/**
 * The connection form is generated from the selected provider's declared
 * fields, so adding a service to the Worker adds it to this page with no change
 * here. What is left is genuinely shared: a label, the credential pair, and the
 * submit flow.
 */
export function ConnectionNew() {
	const meta = useAsync(() => api.meta(), []);
	const providers = meta.data?.providers ?? [];

	const [provider, setProvider] = useState('');
	const [label, setLabel] = useState('');
	const [values, setValues] = useState<Record<string, string>>({});
	const [username, setUsername] = useState('');
	const [secret, setSecret] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);

	const selected = providers.find((entry) => entry.type === provider);

	// Select the first service once metadata arrives.
	useEffect(() => {
		if (!provider && providers.length > 0) setProvider(providers[0].type);
	}, [provider, providers]);

	// Re-seed the config form whenever the service changes, so switching away
	// and back does not carry the previous service's values.
	const selectedType = selected?.type;
	useEffect(() => {
		if (!selected) return;
		setValues(Object.fromEntries(selected.fields.map((field) => [field.name, field.default ?? ''])));
	}, [selectedType]); // eslint-disable-line react-hooks/exhaustive-deps

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const config = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
			setOutcome(
				await api.connections.create({
					provider,
					label,
					config,
					...(username ? { username } : {}),
					secret,
				}),
			);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	if (outcome) {
		const connection = outcome.connection;
		return (
			<>
				<h1>Connection added</h1>
				{outcome.test.ok ? (
					<Alert kind="ok">
						Credentials verified
						{connection ? ` and ${connection.resources.length} resource(s) discovered.` : '.'}
					</Alert>
				) : (
					<Alert kind="warn">
						Saved, but verification failed: {outcome.test.error} You can fix the details on the connection page.
					</Alert>
				)}
				{outcome.warnings.map((warning) => (
					<Alert key={warning} kind="warn">
						{warning}
					</Alert>
				))}
				<div className="panel">
					<p>
						Every discovered resource starts at <strong>no access</strong>. Open the connection to enable the ones that
						agents may use.
					</p>
					{connection ? (
						<Link to={`/connections/${connection.id}`}>
							<button className="primary">Review and scope resources</button>
						</Link>
					) : null}
				</div>
			</>
		);
	}

	return (
		<>
			<h1>Add a connection</h1>
			<p className="lead">
				Muse Proxy signs in on your behalf and never gives the stored password to an agent. Credentials are encrypted before
				they are stored.
			</p>

			<Alert>{error}</Alert>

			<form className="panel" onSubmit={submit}>
				<div className="grid">
					<Field label="Service">
						<select value={provider} onChange={(event) => setProvider(event.target.value)}>
							{providers.length === 0 ? <option value="">Loading…</option> : null}
							{providers.map((entry) => (
								<option key={entry.type} value={entry.type}>
									{entry.displayName}
								</option>
							))}
						</select>
					</Field>

					<Field label="Label">
						<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Home calendar" required />
					</Field>
				</div>

				{selected ? (
					<>
						{selected.fields.map((field) => (
							<div key={field.name}>
								<div style={{ height: '0.75rem' }} />
								<Field label={field.label} hint={field.help}>
									{renderField(field, values[field.name] ?? '', (next) =>
										setValues((current) => ({ ...current, [field.name]: next })),
									)}
								</Field>
							</div>
						))}

						<div style={{ height: '0.75rem' }} />

						<div className="grid">
							{selected.credentials.usernameRequired ? (
								<Field label={selected.credentials.usernameLabel}>
									<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" required />
								</Field>
							) : null}

							<Field label={selected.credentials.secretLabel} hint={selected.credentials.help}>
								<input
									type="password"
									value={secret}
									onChange={(event) => setSecret(event.target.value)}
									autoComplete="new-password"
									required
								/>
							</Field>
						</div>
					</>
				) : null}

				<div className="row" style={{ marginTop: '1.25rem' }}>
					<button className="primary" type="submit" disabled={busy || !selected}>
						{busy ? 'Checking the server…' : 'Add and discover'}
					</button>
					{selected ? (
						<a className="muted" href={selected.docsUrl} target="_blank" rel="noreferrer">
							{selected.displayName} notes
						</a>
					) : null}
				</div>
			</form>
		</>
	);
}

function renderField(field: ProviderField, value: string, onChange: (next: string) => void) {
	if (field.type === 'select') {
		return (
			<select value={value} onChange={(event) => onChange(event.target.value)}>
				<option value="">Choose…</option>
				{(field.options ?? []).map((option) => (
					<option key={option} value={option}>
						{option}
					</option>
				))}
			</select>
		);
	}

	return (
		<input
			type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			placeholder={field.placeholder}
			autoComplete="off"
			required={field.required}
		/>
	);
}
