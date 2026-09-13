/**
 * Stored-credential injection and the upstream authentication handshake.
 *
 * Turning a user:password login into an API-key login is the whole product, so
 * how the stored credential is presented upstream lives in exactly one place
 * instead of being re-derived per provider. Before this existed the DAV gateway
 * and the DAV discovery client each encoded basic auth independently, which is
 * the kind of duplication that drifts.
 *
 * Two schemes are password-based and therefore negotiable:
 *
 *   - Basic sends the password on every request and is asked for nothing;
 *   - Digest never sends the password, but only after the server has said which
 *     nonce it wants.
 *
 * The gateway therefore *negotiates* rather than trusting the stored label: a
 * request refused with a Digest challenge is retried with a Digest response,
 * using the same password. That matters in both directions — a connection
 * stored as `basic` keeps working against a server that only advertises Digest
 * (Baikal's default), and a server that offers Basic still costs a single
 * round trip.
 *
 * Because a retry can re-send the request, a body-bearing request must be
 * replayable. Callers pass `null` or a buffer for anything that may retry; the
 * gateway does that buffering (see providers/caldav/provider.ts).
 */

import { bytesToBase64, randomToken } from './crypto';
import { digestAuthorization, selectDigestChallenge, type DigestChallenge } from './digest';
import { HttpError } from './http';
import { fetchUpstream, type UpstreamTrace } from './upstream';
import type { ProviderCredentials } from '../providers/types';

/**
 * Auth types the shared strategy understands. Providers may narrow this.
 *
 * `digest` is here for servers that insist on it from the first request; in
 * practice the negotiation below reaches Digest without being told to.
 */
export const SUPPORTED_AUTH_TYPES = ['basic', 'bearer', 'digest'] as const;

/**
 * Set the Authorization header for an upstream request.
 *
 * Covers only the schemes that can be decided synchronously. Digest needs the
 * server's challenge and a hash, so it is handled by `fetchWithStoredAuth`,
 * which is where every upstream request should go.
 *
 * Mutates and returns `headers` so callers can compose it with the sanitised
 * inbound headers, whose own authorization has already been stripped.
 */
export function applyUpstreamAuth(headers: Headers, authType: string, credentials: ProviderCredentials): Headers {
	const type = authType.trim().toLowerCase();

	if (type === 'basic') {
		if (!credentials.username) {
			throw new HttpError(400, 'invalid_credentials', 'Basic auth needs a username.');
		}
		// Encode as UTF-8 first: btoa alone rejects non-Latin1 credentials.
		const raw = `${credentials.username}:${credentials.secret}`;
		headers.set('authorization', `Basic ${bytesToBase64(new TextEncoder().encode(raw))}`);
		return headers;
	}

	if (type === 'bearer') {
		headers.set('authorization', `Bearer ${credentials.secret}`);
		return headers;
	}

	throw new HttpError(
		500,
		'unsupported_auth_type',
		`The stored auth type '${authType}' cannot be applied directly. Supported types are ${SUPPORTED_AUTH_TYPES.join(', ')}.`,
	);
}

/** True for the schemes that present a username and password. */
function isPasswordAuth(authType: string): boolean {
	const type = authType.trim().toLowerCase();
	return type === 'basic' || type === 'digest';
}

// -- digest sessions ---------------------------------------------------------

interface DigestSession {
	origin: string;
	challenge: DigestChallenge;
	cnonce: string;
	/** Requests already made against this nonce. */
	nc: number;
	createdAt: number;
}

/**
 * A nonce lives for as long as the server says it does; this is only a
 * best-effort cache to keep the handshake off the hot path. Isolates are
 * short-lived and per-colo, so a miss costs one extra round trip and nothing
 * else — the cache is an optimisation, never a source of truth.
 *
 * Every entry is a Digest session, because only a refused request creates one:
 * a server that accepts Basic answers 200 and leaves nothing to remember.
 * Lookups are therefore keyed by connection alone, and a connection stored as
 * `basic` still reuses the Digest nonce it negotiated.
 */
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 200;
const sessions = new Map<string, DigestSession>();

function readSession(key: string, origin: string): DigestSession | null {
	const session = sessions.get(key);
	if (!session) return null;
	if (session.origin !== origin || Date.now() - session.createdAt > SESSION_TTL_MS) {
		sessions.delete(key);
		return null;
	}
	// Re-insert so iteration order stays least-recently-used.
	sessions.delete(key);
	sessions.set(key, session);
	return session;
}

function startSession(key: string, origin: string, challenge: DigestChallenge): DigestSession {
	const session: DigestSession = { origin, challenge, cnonce: randomToken(16), nc: 0, createdAt: Date.now() };
	sessions.delete(key);
	sessions.set(key, session);

	while (sessions.size > MAX_SESSIONS) {
		const oldest = sessions.keys().next().value;
		if (oldest === undefined) break;
		sessions.delete(oldest);
	}
	return session;
}

function forgetSession(key: string): void {
	sessions.delete(key);
}

// -- the authenticated request ----------------------------------------------

export interface StoredAuthRequest {
	url: URL;
	method: string;
	/** Sanitised headers; the gateway's inbound Authorization is already gone. */
	headers: Headers;
	/** Must be replayable (null or a buffer) when a retry may send it again. */
	body?: BodyInit | null;
	authType: string;
	credentials: ProviderCredentials;
	/** Identity for reusing a Digest nonce between requests, e.g. a connection id. */
	stateKey: string;
	/** Redirects are only followed within this origin. */
	allowedOrigin: string;
	followRedirects?: boolean;
	timeoutMs?: number;
}

export interface StoredAuthResult {
	response: Response;
	/** The request that finally answered; a retry can change the method. */
	trace: UpstreamTrace;
}

/**
 * Perform an upstream request with the stored credential.
 *
 * Basic and bearer go out in one attempt. Digest goes out unauthenticated or
 * with a cached nonce, and is retried exactly once against whatever challenge
 * the server returns — never more, so a server that rejects every response
 * cannot be made to loop.
 */
export async function fetchWithStoredAuth(request: StoredAuthRequest): Promise<StoredAuthResult> {
	const type = request.authType.trim().toLowerCase();
	const trace: UpstreamTrace = { url: request.url, method: request.method, redirects: 0 };
	const credentials = request.credentials;

	if (isPasswordAuth(type) && !credentials.username) {
		throw new HttpError(400, 'invalid_credentials', `${type === 'digest' ? 'Digest' : 'Basic'} auth needs a username.`);
	}
	if (!SUPPORTED_AUTH_TYPES.includes(type as (typeof SUPPORTED_AUTH_TYPES)[number])) {
		throw new HttpError(500, 'unsupported_auth_type', `The stored auth type '${request.authType}' is not supported.`);
	}

	/**
	 * `targetBound` says whether the Authorization header is a Digest response,
	 * which is computed for one specific request-target and cannot be replayed
	 * after a redirect. That is true for an explicit `digest` connection and for
	 * one that negotiated its way there, so it is passed per attempt rather than
	 * derived from the stored type.
	 */
	const send = (url: URL, headers: Headers, targetBound: boolean): Promise<Response> =>
		fetchUpstream({
			url,
			method: request.method,
			headers,
			body: request.body,
			allowedOrigin: request.allowedOrigin,
			followRedirects: request.followRedirects,
			dropAuthorizationOnRedirect: targetBound,
			timeoutMs: request.timeoutMs,
			trace,
		});

	// Attempt 1: a cached Digest nonce if we have one, otherwise whatever the
	// stored type says. `digest` has nothing to send before being challenged.
	const first = new Headers(request.headers);
	let session = isPasswordAuth(type) ? readSession(request.stateKey, request.url.origin) : null;

	if (session) {
		first.set('authorization', await authorizeDigest(session, request.url));
	} else if (type !== 'digest') {
		applyUpstreamAuth(first, type, credentials);
	}

	const response = await send(request.url, first, type === 'digest' || session !== null);
	if (response.status !== 401 || !isPasswordAuth(type)) {
		return { response, trace };
	}

	// The server refused. If it wants Digest, answer it: Basic and Digest are two
	// presentations of the same secret, and a server advertising only Digest
	// cannot be satisfied any other way.
	const selection = selectDigestChallenge(response.headers);
	if (!selection.challenge) {
		if (session) forgetSession(request.stateKey);
		return { response, trace };
	}

	// `trace.url` is where the challenge came from, which is not always the URL
	// first asked for: a well-known endpoint commonly redirects to the real one,
	// and the digest has to be computed for the URL that actually answers.
	const challenged = trace.url;

	if (session) forgetSession(request.stateKey);
	session = startSession(request.stateKey, challenged.origin, selection.challenge);

	const retry = new Headers(request.headers);
	retry.set('authorization', await authorizeDigest(session, challenged));
	const retried = await send(challenged, retry, true);

	// A nonce the server has already rejected would only repeat the failure, so
	// do not keep it. Whatever comes back is the caller's to report.
	if (retried.status === 401) forgetSession(request.stateKey);

	return { response: retried, trace };

	async function authorizeDigest(current: DigestSession, url: URL): Promise<string> {
		if (request.body && typeof (request.body as { getReader?: unknown }).getReader === 'function') {
			throw new HttpError(
				500,
				'body_not_replayable',
				'A Digest challenge needs the request body again, but it was supplied as a stream. Buffer it first.',
			);
		}
		// Advance the nonce count synchronously so concurrent requests cannot
		// both claim the same one.
		const nc = (current.nc += 1);
		return digestAuthorization(
			current.challenge,
			{ username: credentials.username ?? '', password: credentials.secret },
			// The digest covers the request-target of the request as sent, which is
			// the upstream path — not the gateway path the agent addressed.
			{ method: request.method, uri: url.pathname + url.search },
			{ cnonce: current.cnonce, nc },
		);
	}
}
