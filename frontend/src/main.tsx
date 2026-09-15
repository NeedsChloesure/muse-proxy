import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
	<StrictMode>
		{/* Production is mounted at /user/; Vite serves the app at / during local web development. */}
		<BrowserRouter basename={import.meta.env.DEV ? undefined : '/user'}>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
