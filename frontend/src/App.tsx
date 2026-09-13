import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';

import { api, type Account, type Meta } from './lib/api';
import { AuthScreen } from './pages/Auth';
import { ConnectionDetail } from './pages/ConnectionDetail';
import { ConnectionNew } from './pages/ConnectionNew';
import { Dashboard } from './pages/Dashboard';
import { KeyDetailPage, KeysPage } from './pages/Keys';
import { SettingsPage } from './pages/Misc';

export function App() {
	const [phase, setPhase] = useState<'loading' | 'anon' | 'ready'>('loading');
	const [account, setAccount] = useState<Account | null>(null);
	const [meta, setMeta] = useState<Meta | null>(null);

	useEffect(() => {
		void api
			.meta()
			.then(setMeta)
			.catch(() => undefined);

		void api
			.me()
			.then(({ account: found }) => {
				setAccount(found);
				setPhase('ready');
			})
			.catch(() => setPhase('anon'));
	}, []);

	if (phase === 'loading') return <div className="center">Loading…</div>;

	if (phase === 'anon' || !account) {
		return (
			<div className="center">
				<div style={{ width: '100%', maxWidth: '24rem' }}>
					<AuthScreen
						meta={meta}
						onAuthed={(authed) => {
							setAccount(authed);
							setPhase('ready');
						}}
					/>
				</div>
			</div>
		);
	}

	return (
		<Shell
			account={account}
			onSignOut={() => {
				setAccount(null);
				setPhase('anon');
			}}
		/>
	);
}

function Shell({ account, onSignOut }: { account: Account; onSignOut: () => void }) {
	return (
		<div className="app">
			<nav className="sidebar">
				<NavLink to="/" className="brand">
					Muse Proxy
					<span>agent access gateway</span>
				</NavLink>
				<NavLink to="/" end className="navlink">
					Connections
				</NavLink>
				<NavLink to="/keys" className="navlink">
					API keys
				</NavLink>
				<NavLink to="/settings" className="navlink">
					Settings
				</NavLink>
				<div className="spacer" />
				<div className="muted" style={{ padding: '0 0.6rem 0.4rem', fontSize: '0.78rem' }}>
					{account.username}
					{account.isAdmin ? ' · admin' : ''}
				</div>
				<button
					className="navlink"
					style={{ textAlign: 'left' }}
					onClick={() => {
						void api.logout().catch(() => undefined);
						onSignOut();
					}}
				>
					Sign out
				</button>
			</nav>

			<main>
				<Routes>
					<Route path="/" element={<Dashboard />} />
					<Route path="/connections/new" element={<ConnectionNew />} />
					<Route path="/connections/:id" element={<ConnectionDetail />} />
					<Route path="/keys" element={<KeysPage />} />
					<Route path="/keys/:id" element={<KeyDetailPage />} />
					<Route path="/settings" element={<SettingsPage account={account} />} />
					<Route path="*" element={<p className="muted">Page not found.</p>} />
				</Routes>
			</main>
		</div>
	);
}
