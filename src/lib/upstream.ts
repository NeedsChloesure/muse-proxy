/**
 * Upstream HTTP with an SSRF-safe redirect policy.
 *
 * Requests to the upstream service carry the user's real credentials, so a
 * redirect must never be followed to a different origin: that would hand the
 * credentials to whoever controls the Location header. Only same-origin hops
 * are followed, and only a small number of them.
 */

import { HttpError } from './http';

export const HOP_BY_HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-length',
];

/** Headers an agent may never control on the upstream request. */
const NEVER_FORWARD = new Set([...HOP_BY_HOP_HEADERS, 'authorization', 'cookie', 'set-cookie']);

export function sanitizeRequestHeaders(headers: Headers): Headers {
	const out = new Headers();
	for (const [name, value] of headers) {
		if (NEVER_FORWARD.has(name.toLowerCase())) continue;
		out.set(name, value);
	}
	return out;
}

export function sanitizeResponseHeaders(headers: Headers): Headers {
	const out = new Headers();
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (lower === 'set-cookie' || HOP_BY_HOP_HEADERS.includes(lower)) continue;
		out.set(name, value);
	}
	return out;
}

export interface FetchUpstreamOptions {
	url: URL;
	method: string;
	headers: Headers;
	body?: BodyInit | null;
	/** Redirects are only followed within this origin. */
	allowedOrigin: string;
	maxRedirects?: number;
	/**
	 * Filled in with what actually answered, once redirects have been followed.
	 * Callers that report failures need this: naming the requested URL when a
	 * redirect moved the request describes a request that was never made.
	 */
	trace?: UpstreamTrace;
	/**
	 * Whether same-origin redirects are followed at all. Discovery sets this
	 * (well-known endpoints routinely redirect); the agent gateway does not, so
	 * it can hand the 3xx — and a rewritten Location — straight back to the
	 * caller instead of silently re-issuing the request. Re-issuing would also
	 * re-send an already-consumed request stream on a 307/308.
	 */
	followRedirects?: boolean;
	/**
	 * Drop the Authorization header on each hop.
	 *
	 * A Digest response is computed over one specific request-target, so reusing
	 * it after a redirect is either a 400 (the server checks that `uri` matches
	 * the request line) or a wrong digest. Basic and bearer are not bound to a
	 * target and must NOT be dropped: servers that redirect to their
	 * authenticated endpoint — a /.well-known/caldav 301 to /dav.php/ — would
	 * otherwise answer every hop with a 401.
	 */
	dropAuthorizationOnRedirect?: boolean;
	/** Absolute wall-clock deadline for callers spanning multiple attempts. */
	deadlineAt?: number;
	/** Wall-clock budget for the whole exchange, in milliseconds. */
	timeoutMs?: number;
}

/**
 * Perform an upstream request, following only same-origin redirects.
 *
 * A cross-origin redirect is returned to the caller rather than followed, so
 * the agent sees the 3xx (with a Location it can inspect) and the credentials
 * never travel off-origin.
 */
export async function fetchUpstream(options: FetchUpstreamOptions): Promise<Response> {
	const deadline = options.deadlineAt ?? Date.now() + (options.timeoutMs ?? 30_000);
	const maxRedirects = options.followRedirects === false ? 0 : options.maxRedirects ?? 3;
	let url = options.url;
	let method = options.method;
	let headers = options.headers;
	let body = options.body ?? null;
	let redirects = 0;

	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new HttpError(504, 'upstream_timeout', 'The upstream exchange exceeded its time limit.');
		let response: Response;
		try {
			response = await fetch(url.toString(), {
				method,
				headers,
				body: body === null ? undefined : body,
				redirect: 'manual',
				signal: AbortSignal.timeout(remaining),
			});
		} catch (error) {
			if (Date.now() >= deadline) {
				throw new HttpError(504, 'upstream_timeout', 'The upstream exchange exceeded its time limit.');
			}
			throw error;
		}

		if (response.status < 300 || response.status >= 400) {
			recordTrace(options.trace, url, method, redirects);
			return response;
		}

		const location = response.headers.get('location');
		if (!location) {
			recordTrace(options.trace, url, method, redirects);
			return response;
		}
		if (redirects >= maxRedirects) {
			// maxRedirects === 0 means "do not follow": hand the 3xx back.
			if (redirects === 0) {
				recordTrace(options.trace, url, method, redirects);
				return response;
			}
			throw new HttpError(508, 'too_many_redirects', 'Upstream redirected too many times.');
		}

		const next = resolveRedirect(location, url);
		if (next.origin !== options.allowedOrigin) {
			// Hand the 3xx back instead of following it.
			recordTrace(options.trace, url, method, redirects);
			return response;
		}

		// Only 303 is defined to become a GET, and only POST is defined to become
		// a GET on 301/302 (RFC 9110 15.4.2-15.4.4). Downgrading every other
		// method would silently turn a PROPFIND into a bodyless GET, so a DAV
		// server that redirects — Baikal's /.well-known/caldav 301s to
		// /dav.php/ — would be probed in a way it cannot answer, and the failure
		// would be reported against a method and URL never used.
		const degrade = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST');
		const dropAuthorization = options.dropAuthorizationOnRedirect === true && headers.has('authorization');

		if (degrade || dropAuthorization) {
			// Copy before mutating: `headers` is the caller's object.
			headers = new Headers(headers);
		}
		if (degrade) {
			method = 'GET';
			body = null;
			headers.delete('content-type');
		}
		if (dropAuthorization) headers.delete('authorization');

		// This hop is being re-issued, so the 3xx response is discarded. Release
		// its body explicitly: an abandoned stream keeps the upstream connection
		// open until it happens to be collected.
		try {
			await response.body?.cancel();
		} catch {
			// Already consumed or locked; nothing left to release.
		}

		url = next;
		redirects++;
	}
}

/** What finally answered a followed request. */
export interface UpstreamTrace {
	url: URL;
	method: string;
	redirects: number;
}

function recordTrace(trace: UpstreamTrace | undefined, url: URL, method: string, redirects: number): void {
	if (!trace) return;
	trace.url = url;
	trace.method = method;
	trace.redirects = redirects;
}

function resolveRedirect(location: string, current: URL): URL {
	try {
		return new URL(location, current);
	} catch {
		throw new HttpError(502, 'bad_upstream_redirect', 'Upstream sent an unparseable Location header.');
	}
}

/** Absolute form of a Location header, for passing through to the agent. */
export function absolutizeLocation(location: string, base: URL): string | null {
	try {
		const url = new URL(location, base);
		return url.origin === base.origin ? url.toString() : null;
	} catch {
		return null;
	}
}
