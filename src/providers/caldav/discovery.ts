/**
 * CalDAV/CardDAV discovery.
 *
 * The chain, in the order servers actually implement it:
 *   1. PROPFIND the configured base for `current-user-principal`
 *      (falling back to /.well-known/caldav when the base doesn't answer);
 *   2. PROPFIND the principal for `calendar-home-set` / `addressbook-home-set`;
 *   3. PROPFIND each home at Depth 1 and classify the results.
 *
 * Whatever is discovered becomes the scope universe the user can grant. When a
 * server is nonstandard the UI falls back to adding resources by path.
 *
 * Two server behaviours drive the shape of this file, because they are what
 * actually breaks real connections:
 *
 *   - the DAV endpoint is often not at the host root. Baikal mounts it at
 *     /dav.php/ and Nextcloud at /remote.php/dav/, while the root is a web
 *     interface that answers PROPFIND with a redirect, an HTML page, or a 401
 *     from its own authentication. A base URL that points at a web interface
 *     must not be fatal, so /.well-known/caldav is tried after any failure,
 *     and the error says which URL and which challenge it saw;
 *   - /.well-known/caldav is routinely a 301 to the real endpoint (Baikal's
 *     .htaccess does exactly this), so a redirect must not rewrite a PROPFIND
 *     into a GET — see fetchUpstream.
 */

import { urlPolicy } from '../../config';
import { parseAuthChallenges, selectDigestChallenge } from '../../lib/digest';
import { HttpError } from '../../lib/http';
import type { UpstreamTrace } from '../../lib/upstream';
import { fetchWithStoredAuth } from '../../lib/upstream-auth';
import { assertAllowedBaseUrl, toResourceKey } from '../../lib/url';
import { configString } from '../gateway';
import type { DiscoveredResource } from '../../types';
import type { AdminProviderCtx, ProviderCredentials, TestResult } from '../types';
import {
	extractDavError,
	parseMultistatus,
	PROPFIND_COLLECTIONS,
	PROPFIND_HOME_SETS,
	PROPFIND_PRINCIPAL,
	type DavResponse,
} from './xml';

const USER_AGENT = 'MuseProxy/1.0';

/** Challenges the shared credential strategy can answer. */
const ANSWERABLE_SCHEMES = new Set(['basic', 'bearer', 'digest']);

export interface DavSessionInput {
	env: Env;
	/** Provider-owned config; `baseUrl` is this provider's one required field. */
	config: Record<string, unknown>;
	credentials: ProviderCredentials;
	authType: string;
	/** Reuses a Digest nonce across the requests of one connection. */
	connectionId: string;
}

/** One DAV exchange, with what actually answered and whether it looked like DAV. */
interface ProbeResult {
	responses: DavResponse[];
	/** The URL that finally answered, once same-origin redirects were followed. */
	url: URL;
	/** The method actually used; a 303 downgrade can change it. */
	method: string;
	status: number;
	contentType: string | null;
	/** False for a web page or any other non-multistatus body. */
	looksLikeDav: boolean;
}

interface DavSession {
	base: URL;
	credentials: ProviderCredentials;
	authType: string;
	propfind: (url: URL, depth: string, body: string) => Promise<ProbeResult>;
}

export function createSession(ctx: DavSessionInput): DavSession {
	const policy = urlPolicy(ctx.env);
	const base = assertAllowedBaseUrl(configString(ctx.config, 'baseUrl'), policy);
	const { credentials, authType, connectionId } = ctx;

	return {
		base,
		credentials,
		authType,
		async propfind(url: URL, depth: string, body: string): Promise<ProbeResult> {
			if (url.origin !== base.origin) {
				throw new HttpError(400, 'invalid_base_url', 'Refusing to contact a different origin during discovery.');
			}

			const headers = new Headers({
				depth,
				'content-type': 'application/xml; charset=utf-8',
				accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
				'user-agent': USER_AGENT,
			});

			// The trace is what lets a failure name the request that was actually
			// made: after a redirect, reporting the requested path and method
			// describes something that never happened.
			let response: Response;
			let trace: UpstreamTrace;
			try {
				({ response, trace } = await fetchWithStoredAuth({
					url,
					method: 'PROPFIND',
					headers,
					body,
					authType,
					credentials,
					stateKey: connectionId,
					allowedOrigin: base.origin,
				}));
			} catch (error) {
				if (error instanceof HttpError) throw error;
				const reason = error instanceof Error ? error.message : 'unknown error';
				throw new HttpError(502, 'upstream_unreachable', `Could not reach ${base.host}: ${reason}`);
			}

			const text = await response.text();
			if (!response.ok) throw describeFailure(base.host, response, trace, text);

			return {
				responses: parseMultistatus(text),
				url: trace.url,
				method: trace.method,
				status: response.status,
				contentType: response.headers.get('content-type'),
				looksLikeDav: /<([A-Za-z0-9._-]+:)?multistatus[\s>]/i.test(text),
			};
		},
	};
}

/**
 * Turn a failed DAV exchange into an error that names the real cause.
 *
 * 401 is the single most common failure, and it has several very different
 * causes. Saying "the server rejected these credentials" for all of them sends
 * people to rotate a password that was already correct, so the offered
 * challenges and the path that answered are both reported.
 *
 * By the time a 401 reaches here the gateway has already answered whatever
 * challenge it could, so this is about distinguishing "your password is wrong"
 * from "your server wants something nobody can send".
 */
function describeFailure(host: string, response: Response, trace: UpstreamTrace, text: string): HttpError {
	const path = trace.url.pathname;
	const challenges = parseAuthChallenges(response.headers);
	const schemes = challenges.map((challenge) => titleCase(challenge.scheme));
	const realm = challenges.map((challenge) => challenge.params.realm).find(Boolean) ?? null;
	const { rejected } = selectDigestChallenge(response.headers);

	const details = {
		url: trace.url.toString(),
		method: trace.method,
		status: response.status,
		challenges: schemes,
		realm,
		unsupported: rejected,
		redirects: trace.redirects,
		davError: extractDavError(text),
	};

	if (response.status === 401) {
		// A Digest challenge we can see but cannot compute is a different problem
		// from a rejected password, and only one of them is fixable by editing
		// credentials.
		if (rejected.length > 0 && schemes.every((scheme) => scheme === 'Digest')) {
			return new HttpError(
				401,
				'upstream_auth_failed',
				`${host} answered ${path} with HTTP 401 asking for ${rejected.join('; ')}. The stored password was not rejected — this gateway cannot compute the response that challenge needs.`,
				details,
			);
		}

		const unanswerable = challenges.filter(
			(challenge) => !ANSWERABLE_SCHEMES.has(challenge.scheme.toLowerCase()),
		);
		if (unanswerable.length > 0 && challenges.length === unanswerable.length) {
			return new HttpError(
				401,
				'upstream_auth_failed',
				`${host} answered ${path} with HTTP 401 and asked for ${[...new Set(unanswerable.map((c) => titleCase(c.scheme)))].join(', ')} authentication. This gateway presents credentials as basic, bearer or digest, so these cannot be used.`,
				details,
			);
		}

		const realmNote = realm ? `, realm "${realm}"` : '';
		const asked = schemes.length > 0 ? ` The server asked for ${[...new Set(schemes)].join(', ')}.` : '';
		return new HttpError(
			401,
			'upstream_auth_failed',
			`${host} rejected these credentials at ${path} (HTTP 401${realmNote}).${asked} Check the username and password, and use an app-specific password for services like iCloud and Fastmail. If the server mounts DAV under a path — Baikal's /dav.php/, Nextcloud's /remote.php/dav/ — the Server URL must point there, not at the web interface.`,
			details,
		);
	}

	if (response.status === 403) {
		return new HttpError(
			403,
			'upstream_forbidden',
			`${host} refused ${path} with HTTP 403. The credentials were accepted, but this account is not allowed to use the DAV endpoint there.`,
			details,
		);
	}

	const davError = details.davError as string | null;
	return new HttpError(
		502,
		'upstream_error',
		`${host} answered ${trace.method} ${path} with HTTP ${response.status}${davError ? ` (${davError})` : ''}.`,
		details,
	);
}

function titleCase(scheme: string): string {
	const lower = scheme.toLowerCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function firstPrincipal(responses: DavResponse[]): string | null {
	for (const response of responses) {
		if (response.prop.currentUserPrincipal) return response.prop.currentUserPrincipal;
	}
	return null;
}

interface ProbeAttempt {
	url: URL;
	probe?: ProbeResult;
	error?: HttpError;
}

/**
 * Find the current user's principal, or fail with an actionable message.
 *
 * The well-known entry point is tried after *any* failure, not only a 404 or
 * 405: a base URL that points at a web interface commonly answers with a
 * redirect, an HTML page, or a 401 from that interface's own authentication,
 * while the real endpoint behind /.well-known/caldav authenticates a DAV user
 * perfectly well. Treating those as fatal is what makes a wrong-but-fixable URL
 * look like a wrong password.
 */
export async function probePrincipal(session: DavSession): Promise<URL> {
	const candidates = [session.base];
	const wellKnown = new URL('/.well-known/caldav', session.base);
	if (wellKnown.href !== session.base.href) candidates.push(wellKnown);

	const attempts: ProbeAttempt[] = [];

	for (const candidate of candidates) {
		try {
			const probe = await session.propfind(candidate, '0', PROPFIND_PRINCIPAL);
			attempts.push({ url: probe.url, probe });

			const href = firstPrincipal(probe.responses);
			if (href) return validatePrincipal(href, session.base);
		} catch (error) {
			const failure = asHttpError(error);
			attempts.push({ url: candidate, error: failure });

			// A host that could not be reached at all will not answer on the
			// well-known path either; retrying only doubles the wait.
			if (failure.code === 'upstream_unreachable') break;
		}
	}

	throw principalError(session.base, attempts);
}

function validatePrincipal(href: string, base: URL): URL {
	const principal = new URL(href, base);
	if (principal.origin !== base.origin) {
		throw new HttpError(422, 'discovery_failed', `The server advertised a principal on another origin (${principal.origin}).`);
	}
	return principal;
}

/**
 * Choose the most useful failure to report.
 *
 * Ranking, most actionable first:
 *   1. a DAV response arrived, so the credentials were accepted — the endpoint
 *      is simply not advertising a principal;
 *   2. an authentication failure, which points at the credentials or the URL;
 *   3. an HTML page where a DAV response was expected, which points at the URL;
 *   4. whatever transport or HTTP failure came first.
 */
function principalError(base: URL, attempts: ProbeAttempt[]): HttpError {
	const host = base.host;
	const answered = attempts.filter((attempt) => attempt.probe);
	const davAnswered = answered.filter((attempt) => attempt.probe!.looksLikeDav);
	const authFailure = attempts.find(
		(attempt) => attempt.error && (attempt.error.code === 'upstream_auth_failed' || attempt.error.code === 'upstream_forbidden'),
	);

	if (davAnswered.length > 0) {
		const last = davAnswered[davAnswered.length - 1];
		return new HttpError(
			422,
			'discovery_failed',
			`${host} did not advertise a current-user-principal at ${last.url.pathname}. The URL is reachable and the credentials were accepted, but this does not look like a CalDAV endpoint.`,
			{ url: last.url.toString() },
		);
	}

	if (authFailure?.error) return authFailure.error;

	const html = answered.find((attempt) => !attempt.probe!.looksLikeDav && isHtml(attempt.probe!.contentType));
	if (html) {
		return new HttpError(
			422,
			'discovery_failed',
			`${host} served an HTML page at ${html.url.pathname} instead of a DAV response. That URL is a web interface, not a CalDAV endpoint — point the Server URL at the DAV path instead (Baikal's /dav.php/, Nextcloud's /remote.php/dav/).`,
			{ url: html.url.toString() },
		);
	}

	const answeredButNotDav = answered.find((attempt) => !attempt.probe!.looksLikeDav);
	if (answeredButNotDav) {
		return new HttpError(
			422,
			'discovery_failed',
			`${host} answered ${answeredButNotDav.probe!.method} ${answeredButNotDav.url.pathname} with HTTP ${answeredButNotDav.probe!.status}, but not with a DAV response. Check that the URL is the CalDAV endpoint rather than a web interface.`,
			{ url: answeredButNotDav.url.toString() },
		);
	}

	const firstFailure = attempts.find((attempt) => attempt.error);
	if (firstFailure?.error) return firstFailure.error;

	return new HttpError(422, 'discovery_failed', `${host} did not answer a DAV request at ${base.pathname} or /.well-known/caldav.`);
}

function isHtml(contentType: string | null): boolean {
	return (contentType ?? '').toLowerCase().includes('html');
}

function asHttpError(error: unknown): HttpError {
	if (error instanceof HttpError) return error;
	return new HttpError(502, 'upstream_unreachable', error instanceof Error ? error.message : 'unknown error');
}

function relativeToBase(url: URL, base: URL): string | null {
	if (url.origin !== base.origin) return null;
	if (!url.pathname.startsWith(base.pathname)) return null;
	return url.pathname.slice(base.pathname.length);
}

export async function discoverCalDav(ctx: AdminProviderCtx): Promise<{ resources: DiscoveredResource[]; warnings: string[] }> {
	const session = createSession(ctx);
	const principal = await probePrincipal(session);

	const homes: string[] = [];
	for (const response of (await session.propfind(principal, '0', PROPFIND_HOME_SETS)).responses) {
		homes.push(...response.prop.calendarHomeSet, ...response.prop.addressbookHomeSet);
	}
	if (homes.length === 0) {
		throw new HttpError(
			422,
			'discovery_failed',
			'The server advertised no calendar or address book home set for this account. Add resource paths manually if you know them.',
		);
	}

	const warnings: string[] = [];
	const found = new Map<string, DiscoveredResource>();

	for (const homeHref of homes) {
		let homeUrl: URL;
		try {
			homeUrl = new URL(homeHref, session.base);
		} catch {
			continue;
		}
		if (homeUrl.origin !== session.base.origin) {
			warnings.push(`Skipped a home set on another origin (${homeUrl.origin}).`);
			continue;
		}

		let responses: DavResponse[];
		try {
			responses = (await session.propfind(homeUrl, '1', PROPFIND_COLLECTIONS)).responses;
		} catch (error) {
			warnings.push(`Could not list ${homeUrl.pathname}: ${error instanceof Error ? error.message : 'unknown error'}`);
			continue;
		}

		for (const response of responses) {
			if (!response.prop.isCalendar && !response.prop.isAddressbook) continue;

			let url: URL;
			try {
				url = new URL(response.href, homeUrl);
			} catch {
				continue;
			}

			const relative = relativeToBase(url, session.base);
			if (relative === null) {
				warnings.push(`Skipped ${url.pathname}: it is outside the configured base path, so agents cannot address it.`);
				continue;
			}

			const resourceKey = toResourceKey(relative);
			if (!resourceKey || found.has(resourceKey)) continue;

			found.set(resourceKey, {
				resourceKey,
				kind: response.prop.isCalendar ? 'calendar' : 'addressbook',
				displayName: response.prop.displayName || resourceKey,
				meta: {
					source: 'discovered',
					...(response.prop.components.length > 0 ? { components: response.prop.components } : {}),
				},
			});
		}
	}

	const resources = [...found.values()].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
	if (resources.length === 0) {
		throw new HttpError(
			422,
			'no_collections',
			'Reached the server but found no calendars or address books under the configured base URL. Check the URL, or add resource paths manually.',
		);
	}
	return { resources, warnings };
}

export async function testConnection(ctx: AdminProviderCtx): Promise<TestResult> {
	try {
		await probePrincipal(createSession(ctx));
		return { ok: true };
	} catch (error) {
		if (error instanceof HttpError) return { ok: false, error: error.message };
		return { ok: false, error: error instanceof Error ? error.message : 'Unknown error while contacting the server.' };
	}
}
