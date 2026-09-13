import { Link } from 'react-router-dom';

import { Alert, StatusPill, relativeTime, useAsync } from '../components';
import { api, configSummary, type Meta, type ProviderField } from '../lib/api';
import { keyUsageState } from '../lib/keyActivity';

/** Connections overview: what is wired up, and how much of it agents can reach. */
export function Dashboard() {
	const connections = useAsync(() => api.connections.list(), []);
	const keys = useAsync(() => api.keys.list(), []);
	const meta = useAsync(() => api.meta(), []);

	const list = connections.data?.connections ?? [];
	const keyList = keys.data?.keys ?? [];
	const activeKeys = keyList.filter((key) => key.active).length;
	// A dead key that was in use when it died: its agent is plausibly still
	// running and hitting walls. Worth naming on the dashboard, not just in the
	// key list.
	const suspectKeys = keyList.filter((key) => keyUsageState(key, Date.now()) === 'suspect').length;

	return (
		<>
			<div className="between">
				<div>
					<h1>Connections</h1>
					<p className="lead">
						Services you have connected. Nothing is reachable by an agent until you both enable a resource here and grant it to a key.
					</p>
				</div>
				<Link to="/connections/new">
					<button className="primary">Add connection</button>
				</Link>
			</div>

			<Alert>{connections.error ?? keys.error}</Alert>

			{connections.loading ? (
				<p className="muted">Loading…</p>
			) : list.length === 0 ? (
				<div className="panel">
					<p>No connections yet.</p>
					<p className="hint">
						Add a service and Muse Proxy will sign in, discover what it exposes, and let you scope each resource per key.
					</p>
				</div>
			) : (
				list.map((connection) => {
					const enabled = connection.resources.filter((resource) => resource.maxAccess !== 'none').length;
					return (
						<div key={connection.id} className="panel">
							<div className="between">
								<div>
									<h2 style={{ margin: 0 }}>
										<Link to={`/connections/${connection.id}`}>{connection.label}</Link>{' '}
										<StatusPill status={connection.status} />
									</h2>
									<div className="muted mono">{configSummary(connection.config, fieldsFor(meta.data, connection.provider))}</div>
									{connection.lastError ? <div className="hint">{connection.lastError}</div> : null}
								</div>
								<div className="muted" style={{ textAlign: 'right' }}>
									<div>
										{enabled} of {connection.resources.length} resources enabled
									</div>
									<div>updated {relativeTime(connection.updatedAt)}</div>
								</div>
							</div>
						</div>
					);
				})
			)}

			<div className="panel">
				<div className="between">
					<div>
						<h2 style={{ margin: 0 }}>API keys</h2>
						<p className="hint">
							{activeKeys} active of {keyList.length} total. Each key carries its own grants.
							{suspectKeys > 0 ? ` ${suspectKeys} expired ${suspectKeys === 1 ? 'key was' : 'keys were'} still in use within the last week.` : ''}
						</p>
					</div>
					<Link to="/keys">
						<button>Manage keys</button>
					</Link>
				</div>
			</div>
		</>
	);
}

/** A connection's line summary uses the field order its provider declares. */
function fieldsFor(meta: Meta | null, provider: string): readonly ProviderField[] {
	return meta?.providers.find((entry) => entry.type === provider)?.fields ?? [];
}
