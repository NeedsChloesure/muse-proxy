import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
	<StrictMode>
		{/* Served from /user/, including when the Worker serves the shell for a deep link. */}
		<BrowserRouter basename="/user">
			<App />
		</BrowserRouter>
	</StrictMode>,
);
