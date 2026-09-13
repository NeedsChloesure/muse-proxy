import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { api, errorMessage, type Access, type Connection, type Grant } from './lib/api';
import { effectiveAccess, setAllCollections, setCollectionLevel, wildcardIn } from './lib/grants';

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'warn'; children: ReactNode }) {
	if (!children) return null;
	return <div className={`alert ${kind}`}>{children}</div>;
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div>
			<label>{label}</label>
			{children}
			{hint ? <p className="hint">{hint}</p> : null}
		</div>
	);
}

export function StatusPill({ status }: { status: string }) {
	const kind = status === 'ok' ? 'ok' : status === 'error' ? 'bad' : 'muted';
	return <span className={`pill ${kind}`}>{status}</span>;
}

export function relativeTime(timestamp: number): string {
	const seconds = Math.round((Date.now() - timestamp) / 1000);
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

const LEVELS: Access[] = ['none', 'read', 'write'];

function LevelPicker({ value, onChange, name }: { value: Access; onChange: (level: Access) => void; name: string }) {
	return (
		<div className="radio-group">
			{LEVELS.map((level) => (
				<label key={level}>
					<input type="radio" name={name} checked={value === level} onChange={() => onChange(level)} />
					{level}
				</label>
			))}
		</div>
	);
}

/**
 * The scope matrix: for every collection on every connection, choose none, read
 * or write.
 *
 * "All collections" is a wildcard grant — it also covers collections discovered
 * later — while the rows below it stay live. Tuning one row expands the wildcard
 * into explicit per-collection grants (see lib/grants.ts), so setting everything
 * at once never takes away the ability to make one calendar narrower than the
 * rest.
 */
export function ScopeMatrix({
	connections,
	grants,
	onChange,
	emptyMessage = 'No connections yet. Add one first, then come back to choose what this key may reach.',
}: {
	connections: Connection[];
	grants: Grant[];
	onChange: (grants: Grant[]) => void;
	emptyMessage?: string;
}) {
	if (connections.length === 0) return <p className="muted">{emptyMessage}</p>;

	return (
		<div>
			{connections.map((connection) => {
				const wildcard = wildcardIn(grants, connection.id);
				const wildcardOn = wildcard !== 'none';
				return (
					<div key={connection.id} className="panel">
						<div className="scope-head">
							<div>
								<strong>{connection.label}</strong>{' '}
								<span className="muted mono">{connection.provider}</span>
							</div>
							<div className="row">
								<span className="muted">All collections</span>
								<LevelPicker
									name={`wildcard-${connection.id}`}
									value={wildcard}
									onChange={(level) => onChange(setAllCollections(grants, connection.id, level))}
								/>
							</div>
						</div>

						{connection.resources.length === 0 ? (
							<p className="muted">This connection has no collections yet. Run discovery on it first.</p>
						) : (
							<table>
								<thead>
									<tr>
										<th>Collection</th>
										<th>Connection ceiling</th>
										<th>This key</th>
									</tr>
								</thead>
								<tbody>
									{connection.resources.map((resource) => (
										<tr key={resource.id}>
											<td>
												<div>{resource.displayName ?? resource.resourceKey}</div>
												<div className="muted mono">{resource.resourceKey}</div>
											</td>
											<td>
												<span className={`pill ${resource.maxAccess === 'none' ? 'muted' : 'ok'}`}>{resource.maxAccess}</span>
											</td>
											<td>
												{resource.maxAccess === 'none' ? (
													<span className="muted">not enabled on the connection</span>
												) : (
													<LevelPicker
														name={`resource-${resource.id}`}
														value={effectiveAccess(grants, connection.id, resource.resourceKey)}
														onChange={(level) =>
															onChange(
																setCollectionLevel(
																	grants,
																	connection.id,
																	resource.resourceKey,
																	level,
																	connection.resources.map((entry) => entry.resourceKey),
																),
															)
														}
													/>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
						{wildcardOn ? (
							<p className="hint">
								Every collection this connection allows is covered at {wildcard} for this key, including collections
								discovered later. Choosing a level for a single collection below replaces that with explicit grants for the{' '}
								{connection.resources.length} collection(s) known now.
							</p>
						) : (
							<p className="hint">Each collection below is granted on its own. Use All collections to set them all at once.</p>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Shown exactly once, at mint time. */
export function TokenReveal({ token, mountPath }: { token: string; mountPath?: string }) {
	const [copied, setCopied] = useState(false);
	const origin = typeof window === 'undefined' ? 'https://your-worker' : window.location.origin;

	return (
		<div>
			<Alert kind="ok">Copy this key now — it is stored hashed and cannot be shown again.</Alert>
			<div className="token mono">{token}</div>
			<div className="row">
				<button
					onClick={() => {
						void navigator.clipboard.writeText(token).then(() => {
							setCopied(true);
							window.setTimeout(() => setCopied(false), 2000);
						});
					}}
				>
					{copied ? 'Copied' : 'Copy key'}
				</button>
			</div>
			<h3>Try it</h3>
			<pre>{`curl -H "Authorization: Bearer ${token}" \\
  ${origin}/api/agent`}</pre>
			{mountPath ? (
				<pre>{`curl -X PROPFIND -H "Depth: 1" \\
  -H "Authorization: Bearer ${token}" \\
  ${origin}${mountPath}`}</pre>
			) : null}
		</div>
	);
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		loader()
			.then((result) => {
				if (!cancelled) setData(result);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(errorMessage(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, nonce]);

	return { data, error, loading, reload: () => setNonce((value) => value + 1) };
}
