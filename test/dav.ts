import { createHash } from 'node:crypto';

import { fetchMock } from 'cloudflare:test';

import {
	ADDRESSBOOK_HOME,
	ADDRESSBOOK_TYPE,
	CALENDAR_HOME,
	CALENDAR_TYPE,
	DAV,
	DISPLAY_NAME,
	davResponse,
	multistatus,
	normalizeHeaders,
	PRINCIPAL,
} from './helpers';

/**
 * A single catch-all interceptor for the upstream DAV server.
 *
 * Registering per-route interceptors does not work here: interceptors accumulate
 * across tests and the first match wins, so a later test's stubs would be
 * shadowed by earlier ones. Instead one persistent interceptor records every
 * request and looks the response up in a mutable table that each test resets.
 */

export interface SeenRequest {
	method: string;
	path: string;
	authorization: string;
	headers: Record<string, string>;
	/** Decoded request body, so a replayed write can be checked. */
	body: string;
}

export interface StubResponse {
	status: number;
	body?: string;
	headers?: Record<string, string>;
}

const XML: Record<string, string> = { 'content-type': 'application/xml; charset=utf-8' };

let overrides = new Map<string, StubResponse>();
let captured: SeenRequest[] = [];
let installed = false;
let digestGuard: DigestGuard | null = null;

const UNSTUBBED: StubResponse = { status: 404, body: 'no stub registered for this route' };

/**
 * A server that answers only a correct Digest response — the shape of Baikal's
 * default configuration, and of SabreDAV generally.
 */
export interface DigestGuard {
	/** Paths that answer without authentication. */
	exempt: string[];
	/** The exact WWW-Authenticate value to send with every 401. */
	header: string;
	/** When set, a correctly answered challenge is accepted. */
	accepts?: {
		realm: string;
		username: string;
		password: string;
		nonce: string;
		algorithm: 'MD5' | 'SHA-256';
	};
}

export const dav = {
	/** Every request the gateway sent upstream, in order. */
	get seen(): SeenRequest[] {
		return captured;
	},

	/** Clear recorded requests and stubs. Call from beforeEach. */
	reset(): void {
		overrides = new Map();
		captured = [];
		digestGuard = null;
	},

	/** Set the response for one route. */
	stub(method: string, path: string, response: StubResponse): void {
		overrides.set(`${method.toUpperCase()} ${path}`, response);
	},

	/**
	 * Demand Digest authentication, as a SabreDAV-based server does by default.
	 * A request without a verified response gets a 401 carrying the challenge, and
	 * only the matching password is accepted.
	 *
	 * `exempt` lists paths that answer without authentication. Real deployments
	 * have them: the rewrite that sends /.well-known/caldav to the real endpoint
	 * runs in the web server, before any DAV authentication is reached.
	 */
	requireDigest(options: {
		username: string;
		password: string;
		algorithm?: 'MD5' | 'SHA-256';
		exempt?: string[];
	}): void {
		const accepts = {
			realm: 'BaikalDAV',
			nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
			algorithm: 'MD5' as const,
			...options,
		};
		digestGuard = {
			accepts,
			exempt: options.exempt ?? [],
			header: `Digest realm="${accepts.realm}", qop="auth", algorithm=${accepts.algorithm}, nonce="${accepts.nonce}"`,
		};
	},

	/**
	 * Challenge every request with an arbitrary WWW-Authenticate value, accepting
	 * nothing. For challenges this gateway is expected to refuse, such as an
	 * algorithm it cannot compute.
	 */
	challengeWith(header: string): void {
		digestGuard = { header, exempt: [] };
	},

	/** Every Authorization header the server received, in order. */
	get authorizations(): string[] {
		return captured.map((request) => request.authorization);
	},

	/** The three-step discovery chain, as a well-behaved server would answer it. */
	discoveryDefaults(calendarName = 'Work'): void {
		this.stub('PROPFIND', '/', {
			status: 207,
			body: multistatus(davResponse('/', PRINCIPAL('/principals/alice/'))),
			headers: XML,
		});
		this.stub('PROPFIND', '/principals/alice/', {
			status: 207,
			body: multistatus(
				davResponse('/principals/alice/', CALENDAR_HOME('/calendars/alice/') + ADDRESSBOOK_HOME('/addressbooks/alice/')),
			),
			headers: XML,
		});
		this.stub('PROPFIND', '/calendars/alice/', {
			status: 207,
			body: multistatus(
				davResponse('/calendars/alice/', '<D:resourcetype><D:collection/></D:resourcetype>'),
				davResponse('/calendars/alice/work/', CALENDAR_TYPE + DISPLAY_NAME(calendarName)),
				davResponse('/calendars/alice/home/', CALENDAR_TYPE + DISPLAY_NAME('Home')),
			),
			headers: XML,
		});
		this.stub('PROPFIND', '/addressbooks/alice/', {
			status: 207,
			body: multistatus(
				davResponse('/addressbooks/alice/', '<D:resourcetype><D:collection/></D:resourcetype>'),
				davResponse('/addressbooks/alice/people/', ADDRESSBOOK_TYPE + DISPLAY_NAME('People')),
			),
			headers: XML,
		});
	},

	/** Install the catch-all interceptor. Call once, from beforeAll. */
	install(): void {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		if (installed) return;
		installed = true;

		fetchMock
			.get(DAV)
			.intercept({ method: () => true, path: () => true })
			.reply((options: { method?: string; path?: string; headers?: unknown; body?: unknown }) => {
				// Deliberately synchronous: undici's mock does not await a reply
				// callback, so an async one is silently treated as a reply object.
				const method = (options.method ?? 'GET').toUpperCase();
				const path = options.path ?? '/';
				const headers = normalizeHeaders(options.headers);
				captured.push({
					method,
					path,
					authorization: headers.authorization ?? '',
					headers,
					body: decodeBody(options.body),
				});

				if (digestGuard && !digestGuard.exempt.includes(path)) {
					const accepted =
						digestGuard.accepts !== undefined &&
						verifyDigest(digestGuard.accepts, headers.authorization ?? '', method, path);
					if (!accepted) {
						return {
							statusCode: 401,
							data: '',
							responseOptions: { headers: { 'www-authenticate': digestGuard.header } },
						};
					}
				}

				const response = overrides.get(`${method} ${path}`) ?? UNSTUBBED;
				return {
					statusCode: response.status,
					data: response.body ?? '',
					responseOptions: { headers: response.headers ?? { 'content-type': 'text/plain' } },
				};
			})
			.persist();
	},

	uninstall(): void {
		fetchMock.deactivate();
	},
};

function decodeBody(body: unknown): string {
	if (body === undefined || body === null) return '';
	if (typeof body === 'string') return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return String(body);
}

/**
 * Verify a client Digest response.
 *
 * The digest is recomputed with Node's OpenSSL implementation rather than
 * src/lib/digest.ts, so a bug in the module under test cannot make the server
 * agree with it. The published RFC 7616 vectors in test/digest.spec.ts pin the
 * formula itself; this checks the plumbing — that `uri` is the upstream path,
 * and that username, realm, nonce, qop, nc and cnonce travel intact.
 */
function verifyDigest(
	guard: NonNullable<DigestGuard['accepts']>,
	authorization: string,
	method: string,
	path: string,
): boolean {
	if (!authorization.toLowerCase().startsWith('digest ')) return false;

	const params: Record<string, string> = {};
	const pattern = /([A-Za-z][A-Za-z0-9._+-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(authorization.slice(7))) !== null) {
		params[match[1].toLowerCase()] = match[2] ?? match[3];
	}

	if (params.username !== guard.username) return false;
	if (params.realm !== guard.realm) return false;
	if (params.nonce !== guard.nonce) return false;
	// The digest covers the request-target of the request as sent upstream, so a
	// gateway that hashed its own path would be caught here.
	if (params.uri !== path) return false;

	const h = (data: string) => createHash(guard.algorithm.toLowerCase().replace('-', '')).update(data, 'utf8').digest('hex');
	const ha1 = h(`${guard.username}:${guard.realm}:${guard.password}`);
	const ha2 = h(`${method}:${params.uri}`);
	const expected = h(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`);

	return expected === params.response;
}
