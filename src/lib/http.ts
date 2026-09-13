/**
 * HTTP response helpers and the error type used across the Worker.
 */

import { API_VERSION } from '../types';

export interface ErrorDetails {
	[key: string]: unknown;
}

/** Thrown by handlers and middleware; converted to a JSON response at the edge. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: ErrorDetails,
	) {
		super(message);
		this.name = 'HttpError';
	}
}

export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	headers.set('X-Muse-Api-Version', API_VERSION);
	headers.set('cache-control', 'no-store');
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function problem(status: number, code: string, message: string, details?: ErrorDetails): Response {
	return json({ ok: false, apiVersion: API_VERSION, error: { code, message, ...(details ? { details } : {}) } }, { status });
}

/** Envelope for JSON responses on the agent API. */
export function agentJson(data: unknown, notices: unknown[], init: ResponseInit = {}): Response {
	return json({ ok: true, apiVersion: API_VERSION, data, notices }, init);
}

export function notFound(message = 'Not found'): Response {
	return problem(404, 'not_found', message);
}

export function toErrorResponse(error: unknown): Response {
	if (error instanceof HttpError) return problem(error.status, error.code, error.message, error.details);
	console.error('unhandled error', error);
	return problem(500, 'internal_error', 'Internal error');
}

// -- agent-facing notice signalling ------------------------------------------

/**
 * Advertise pending notices on any agent response, including proxied upstream
 * responses whose body cannot be rewritten. Agents read these headers, then
 * fetch /api/agent/notices.
 */
export function withAgentHeaders(
	response: Response,
	opts: { pendingNotices: number; corsOrigin?: string },
): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Muse-Api-Version', API_VERSION);
	headers.set('X-Muse-Notices', String(opts.pendingNotices));
	if (opts.pendingNotices > 0) headers.set('X-Muse-Notices-Url', '/api/agent/notices');
	if (opts.corsOrigin) {
		headers.set('Access-Control-Allow-Origin', opts.corsOrigin);
		headers.set('Access-Control-Expose-Headers', 'X-Muse-Api-Version, X-Muse-Notices, X-Muse-Notices-Url');
		headers.append('Vary', 'Origin');
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Preflight response for an opted-in browser origin. */
export function corsPreflight(origin: string, allowOrigin: string, methods: string[]): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': allowOrigin,
			'Access-Control-Allow-Methods': methods.join(', '),
			'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, If-Match, If-None-Match, Overwrite, Prefer',
			'Access-Control-Max-Age': '600',
			Vary: 'Origin',
		},
	});
}

export function isCorsOriginAllowed(origin: string | null, configured: string | undefined): string | null {
	if (!origin || !configured) return null;
	const allowed = configured
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	return allowed.includes(origin) ? origin : null;
}
