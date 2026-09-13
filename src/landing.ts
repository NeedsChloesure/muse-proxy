/**
 * The landing page at "/".
 *
 * Rendered by the Worker rather than served as a static file: `assets`
 * not_found_handling rewrites every unmatched request to the ROOT /index.html,
 * which is the SPA shell. Keeping the landing out of the assets directory avoids
 * that collision entirely.
 *
 * Defaults to plain text so that an agent hitting / with curl gets something it
 * can read, and only renders HTML for clients that ask for HTML first.
 */

import { API_VERSION } from './types';

const PLAIN = `Muse Proxy — an API-key gateway for services that normally want a password
API version ${API_VERSION}

If you are a human, open the admin console at /user/ — that is where you add
services, set what each one may be used for, and mint API keys.

If you are an agent, do not scrape this page. Read the machine-readable
description of this deployment instead:

  GET /api/agent                 Service catalog. Send
                                 "Authorization: Bearer <key>" to also learn which
                                 connections and collections your key can reach, and
                                 at what access level.
  GET /api/agent/openapi.json    OpenAPI 3.1 specification for this exact version.
  GET /api/agent/notices         Changes the account owner made that affect you
                                 (reduced access, rotated credentials, API updates).
  GET /llms.txt                  Short orientation for language models.
  /docs/                         Documentation, versioned with the code.

Access is scoped twice over and both layers must allow a request: the connection
owner sets a ceiling per collection (calendar or address book), and your key
carries its own grants. A denial tells you which collections you can use.
`;

function html(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Muse Proxy</title>
		<style>
			:root { color-scheme: light dark; }
			body {
				margin: 0 auto; max-width: 46rem; padding: 3rem 1.5rem;
				font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
			}
			h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
			.sub { color: #6b7280; margin: 0 0 2rem; }
			h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin: 2rem 0 0.5rem; }
			code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
			pre { background: rgba(127, 127, 127, 0.12); padding: 1rem; border-radius: 0.5rem; overflow-x: auto; }
			a { color: inherit; }
			.cta { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1.1rem; border-radius: 0.5rem;
				background: #111827; color: #fff; text-decoration: none; font-weight: 600; }
			@media (prefers-color-scheme: dark) { .cta { background: #f9fafb; color: #111827; } }
			@media (prefers-color-scheme: dark) { .sub, h2 { color: #9ca3af; } }
			ul { padding-left: 1.1rem; }
			li { margin: 0.35rem 0; }
		</style>
	</head>
	<body>
		<h1>Muse Proxy</h1>
		<p class="sub">An API-key gateway for services that normally want a password. API version ${API_VERSION}.</p>

		<h2>For people</h2>
		<p>Add a service, choose exactly which calendars or address books it may touch and whether writes are allowed, then mint an API key for the agent that needs it.</p>
		<a class="cta" href="/user/">Open the admin console</a>

		<h2>For agents</h2>
		<p>Do not scrape this page. Read the machine-readable description of this deployment:</p>
		<ul>
			<li><code>GET <a href="/api/agent">/api/agent</a></code> — service catalog. Add <code>Authorization: Bearer &lt;key&gt;</code> to learn which connections and collections your key can reach, and at what access level.</li>
			<li><code>GET <a href="/api/agent/openapi.json">/api/agent/openapi.json</a></code> — OpenAPI 3.1 specification for this exact version.</li>
			<li><code>GET <a href="/api/agent/notices">/api/agent/notices</a></code> — changes that affect you: reduced access, rotated credentials, API updates.</li>
			<li><a href="/llms.txt">/llms.txt</a> — short orientation for language models.</li>
			<li><a href="/docs/">/docs/</a> — documentation, versioned with the code.</li>
		</ul>
		<p>The API is date-versioned and every response carries <code>X-Muse-Api-Version</code>. Responses also carry <code>X-Muse-Notices</code>: when it is non-zero, fetch the notices endpoint and tell the human you are working for.</p>

		<h2>How access works</h2>
		<p>Every request must satisfy two independent layers. The account owner sets a ceiling per collection (calendar or address book) — <code>none</code>, <code>read</code> or <code>write</code> — and each API key carries its own grants. A request is allowed only if both permit it, so a key can never exceed the connection it uses.</p>
		<pre>curl -H "Authorization: Bearer muse_..." \\
  -X PROPFIND -H "Depth: 1" \\
  https://&lt;this-host&gt;/api/agent/caldav/&lt;connectionId&gt;/</pre>
	</body>
</html>
`;
}

function prefersHtml(request: Request): boolean {
	const accept = (request.headers.get('accept') ?? '').toLowerCase();
	const html = accept.indexOf('text/html');
	if (html === -1) return false;
	const plain = accept.indexOf('text/plain');
	return plain === -1 || html < plain;
}

export function renderLanding(request: Request): Response {
	const wantsHtml = prefersHtml(request);
	const body = wantsHtml ? html() : PLAIN;
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
			'cache-control': 'no-cache',
			'X-Muse-Api-Version': API_VERSION,
			Link: '</llms.txt>; rel="describedby", </api/agent/openapi.json>; rel="service-desc"',
		},
	});
}
