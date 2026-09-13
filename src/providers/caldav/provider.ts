/**
 * The CalDAV/CardDAV agent gateway.
 *
 * Agents speak DAV directly to
 *   /api/agent/caldav/<connectionId>/<path-inside-the-upstream-server>
 * and this module decides whether that is allowed before forwarding it with the
 * user's stored credentials.
 *
 * This file owns only the DAV vocabulary: which paths are collections, which
 * HTTP methods need write access, and how to talk to a DAV server. Account
 * isolation, loading the two permission layers and the shape of a refusal are
 * handled by the shared gateway (src/providers/gateway.ts), so they cannot be
 * got wrong here.
 */

import { urlPolicy } from '../../config';
import { decryptSecret } from '../../lib/crypto';
import { HttpError } from '../../lib/http';
import { absolutizeLocation, sanitizeRequestHeaders, sanitizeResponseHeaders } from '../../lib/upstream';
import { fetchWithStoredAuth } from '../../lib/upstream-auth';
import { assertAllowedBaseUrl, normalizePath, resolveUpstreamUrl } from '../../lib/url';
import { ACCESS_RANK, type Access } from '../../types';
import { configString } from '../gateway';
import { parseConfig, validateFields } from '../fields';
import type {
	AdminProviderCtx,
	AgentCtx,
	OpenApiFragment,
	ProviderCredentialFields,
	ProviderField,
	ProviderResult,
	ServiceProvider,
	TestResult,
} from '../types';
import { discoverCalDav, testConnection } from './discovery';
import { caldavOpenApi } from './openapi';
import { extractReportHrefs, toGatewayPath, type ReferenceContext } from './report';
import { resolveDavPath } from './resolve';

const READ_METHODS = new Set(['GET', 'HEAD', 'PROPFIND', 'REPORT']);
const WRITE_METHODS = new Set(['PUT', 'POST', 'DELETE', 'MKCOL', 'MKCALENDAR', 'PROPPATCH', 'MOVE', 'COPY', 'LOCK', 'UNLOCK']);

/** Methods answered by the gateway itself, never forwarded. */
const LOCAL_METHODS = new Set(['OPTIONS']);

const WRITE_ALLOW = 'PUT, POST, DELETE, MKCOL, MKCALENDAR, PROPPATCH, MOVE, COPY, LOCK, UNLOCK';

/** The one thing a CalDAV connection needs beyond its credential pair. */
const CALDAV_FIELDS: readonly ProviderField[] = [
	{
		name: 'baseUrl',
		label: 'Server URL',
		type: 'url',
		required: true,
		placeholder: 'https://caldav.fastmail.com/',
		help: 'The CalDAV or CardDAV collection root. Discovery starts here and falls back to /.well-known/caldav. Servers that mount DAV under a path need it spelled out: Baikal uses /dav.php/, Nextcloud /remote.php/dav/.',
	},
];

const CALDAV_CREDENTIALS: ProviderCredentialFields = {
	usernameLabel: 'Username',
	secretLabel: 'Password',
	usernameRequired: true,
	help: 'For providers such as iCloud, use an app-specific password rather than your account password. Servers that demand Digest authentication (Baikal by default) are negotiated automatically.',
};

function requiredAccess(method: string): Exclude<Access, 'none'> | null {
	if (READ_METHODS.has(method)) return 'read';
	if (WRITE_METHODS.has(method)) return 'write';
	return null;
}

export const caldavProvider: ServiceProvider = {
	type: 'caldav',
	displayName: 'CalDAV / CardDAV',
	summary: 'Calendars and address books behind per-collection read/write scoping.',
	docsPath: '/docs/agent/caldav.html',
	openapiPath: '/api/agent/caldav/openapi.json',
	defaultAuthType: 'basic',
	fields: CALDAV_FIELDS,
	credentials: CALDAV_CREDENTIALS,

	validateConfig(input: unknown): Record<string, unknown> {
		return validateFields(CALDAV_FIELDS, input);
	},

	verifyConfig(config: Record<string, unknown>, env: Env): void {
		assertAllowedBaseUrl(configString(config, 'baseUrl'), urlPolicy(env));
	},

	async test(ctx: AdminProviderCtx): Promise<TestResult> {
		return testConnection(ctx);
	},

	async discover(ctx: AdminProviderCtx) {
		const { resources } = await discoverCalDav(ctx);
		return resources;
	},

	openapi(): OpenApiFragment {
		return caldavOpenApi;
	},

	handle: handleDavRequest,
};

async function handleDavRequest(ctx: AgentCtx): Promise<ProviderResult> {
	const { request, connection } = ctx;
	const policy = urlPolicy(ctx.env);
	const rawBaseUrl = configString(parseConfig(connection.configJson), 'baseUrl');
	const base = assertAllowedBaseUrl(rawBaseUrl, policy);

	const resourceKeys = ctx.scope.map((entry) => entry.resourceKey);
	const path = normalizePath(ctx.rawPath);
	const method = request.method.toUpperCase();
	const decision = ctx.decide(resolveDavPath(path, resourceKeys));

	if (LOCAL_METHODS.has(method)) {
		return { response: optionsResponse(decision.access) };
	}

	const required = requiredAccess(method);
	if (required === null) {
		throw new HttpError(405, 'method_not_allowed', `The gateway does not support ${method}.`, {
			supported: [...READ_METHODS, ...WRITE_METHODS, ...LOCAL_METHODS].sort(),
		});
	}

	// Throws the shared guided 403 when either layer is short.
	ctx.require(decision, required);

	// MOVE/COPY name a destination, which needs its own authorization: a key
	// allowed to write one collection must not be able to move an item into
	// (or out of) another.
	let destination: string | null = null;
	if (method === 'MOVE' || method === 'COPY') {
		destination = authorizeDestination(ctx, { base, connectionId: connection.id, resourceKeys });
	}

	const url = resolveUpstreamUrl(rawBaseUrl, path, policy);
	const headers = sanitizeRequestHeaders(request.headers);
	headers.set('user-agent', 'MuseProxy/1.0');
	if (destination) headers.set('destination', destination);

	const body = await readUpstreamBody(request, method, connection.authType);

	// A REPORT names its own targets inside the body, so the request path alone
	// does not describe what is being asked for.
	if (method === 'REPORT') authorizeReportTargets(ctx, { body, base, path, connectionId: connection.id, resourceKeys });

	let upstream: Response;
	try {
		// The gateway is a transparent proxy: a 3xx is rewritten into gateway
		// coordinates and returned, never followed on the agent's behalf.
		({ response: upstream } = await fetchWithStoredAuth({
			url,
			method,
			headers,
			body,
			authType: connection.authType,
			credentials: {
				username: connection.username,
				secret: await decryptSecret(connection.secretCiphertext, ctx.env),
			},
			// Reuses a Digest nonce across requests on the same connection.
			stateKey: connection.id,
			allowedOrigin: base.origin,
			followRedirects: false,
		}));
	} catch (error) {
		if (error instanceof HttpError) throw error;
		const reason = error instanceof Error ? error.message : 'unknown error';
		throw new HttpError(502, 'upstream_unreachable', `Could not reach ${base.host}: ${reason}`);
	}

	const responseHeaders = sanitizeResponseHeaders(upstream.headers);
	const location = upstream.headers.get('location');
	if (location) {
		// Rewrite upstream redirects back into gateway coordinates so an agent
		// can follow them; drop anything leaving the connection's origin.
		const absolute = absolutizeLocation(location, url);
		const rewritten = absolute ? rewriteToGateway(absolute, base, connection.id) : null;
		if (rewritten) responseHeaders.set('location', rewritten);
		else responseHeaders.delete('location');
	}
	responseHeaders.set('X-Muse-Access', decision.access);
	if (decision.resourceKey) responseHeaders.set('X-Muse-Resource', decision.resourceKey);

	return {
		response: new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders }),
	};
}

/**
 * Authorize every href a REPORT body refers to.
 *
 * The request path is authorized before this runs; this closes the half of the
 * request that the URL does not describe. A `calendar-multiget` addressed to a
 * readable collection can still list hrefs in a collection this key may not
 * read, and the upstream — holding the user's credentials — would return them.
 *
 * REPORTs that name no targets (`calendar-query`, `sync-collection`) pass
 * through untouched, which is the common case.
 */
function authorizeReportTargets(
	ctx: AgentCtx,
	input: { body: BodyInit | null; base: URL; path: string; connectionId: string; resourceKeys: string[] },
): void {
	if (input.body === null) return;
	// Buffered by readUpstreamBody above, which is what lets this read it at all.
	if (!(input.body instanceof ArrayBuffer)) throw unreadableReport();

	const hrefs = extractReportHrefs(new TextDecoder().decode(input.body));
	if (hrefs === null) {
		throw new HttpError(
			400,
			'invalid_report',
			'This REPORT body could not be parsed, so the resources it references cannot be authorized. Send well-formed XML.',
		);
	}

	const context: ReferenceContext = { base: input.base, connectionId: input.connectionId, relativeTo: input.path };
	for (const href of hrefs) {
		const relative = toGatewayPath(href, context);
		if (relative === null) {
			throw new HttpError(
				400,
				'invalid_report_href',
				`This REPORT references '${href}', which is not inside this connection. A REPORT may only name resources on the connection's own server.`,
			);
		}

		const target = normalizePath(relative);
		const decision = ctx.decide(resolveDavPath(target, input.resourceKeys));
		// Reading the target is what a REPORT does, whatever relation it claims.
		ctx.require(
			decision,
			'read',
			`This REPORT references '${href}', which resolves to '${target}' — outside what this key may read.`,
		);
	}
}

function unreadableReport(): HttpError {
	return new HttpError(500, 'body_not_replayable', 'A REPORT body must be buffered so the resources it references can be authorized.');
}

/**
 * How large a write may be before it cannot be replayed for a Digest challenge.
 * An order of magnitude beyond any real calendar or contact payload.
 */
const MAX_REPLAYABLE_BODY = 16 * 1024 * 1024;

/**
 * Methods that never carry a request body, so there is nothing to forward.
 *
 * Deliberately NOT a read/write split. In DAV the request body is not a
 * property of writing: `REPORT` carries its entire query — `calendar-query`,
 * `calendar-multiget`, `sync-collection` — and `PROPFIND` carries the property
 * set to return. Dropping the body of a read method does not degrade it, it
 * changes the question: a bodyless REPORT asks the server to filter nothing,
 * and a bodyless PROPFIND silently degrades to "all properties".
 */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * Read the request body, buffering it when the upstream call may need it twice.
 *
 * Digest costs a round trip to negotiate, so the authenticated request is the
 * second one sent — and a ReadableStream cannot be replayed. Basic is included
 * because a connection stored as `basic` may be upgraded to Digest by the
 * challenge. Bearer never retries, so it keeps streaming. Bodies over the cap
 * are refused rather than silently truncated.
 */
async function readUpstreamBody(request: Request, method: string, authType: string): Promise<BodyInit | null> {
	if (BODYLESS_METHODS.has(method) || request.body === null) return null;

	const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
	if (Number.isFinite(declared) && declared > MAX_REPLAYABLE_BODY) throw tooLarge(declared);

	const type = authType.trim().toLowerCase();
	const replayable = type === 'basic' || type === 'digest';

	// A REPORT body has to be inspected before it is forwarded, and a
	// ReadableStream can only be read once, so it is buffered whatever the auth
	// type. Everything else only needs a buffer when a Digest challenge may make
	// the request be sent a second time.
	if (!replayable && method !== 'REPORT') return request.body;

	const buffer = await request.arrayBuffer();
	if (buffer.byteLength > MAX_REPLAYABLE_BODY) throw tooLarge(buffer.byteLength);
	return buffer;
}

function tooLarge(bytes: number): HttpError {
	return new HttpError(
		413,
		'body_too_large',
		`This request body is ${bytes} bytes, above the ${MAX_REPLAYABLE_BODY} byte limit. A password-authenticated connection may need the body a second time (a Digest challenge), and a REPORT body is inspected before it is forwarded, so either has to be held in memory.`,
	);
}

/**
 * Answer OPTIONS locally: no upstream call, and the Allow header advertises
 * only what the key can actually do, so a client can plan without probing.
 */
function optionsResponse(access: Access): Response {
	const allow = ['OPTIONS', 'GET', 'HEAD', 'PROPFIND', 'REPORT'];
	if (ACCESS_RANK[access] >= ACCESS_RANK.write) allow.push(...WRITE_ALLOW.split(', '));
	return new Response(null, {
		status: 204,
		headers: {
			allow: allow.join(', '),
			dav: '1, 2, 3, calendar-access, addressbook, extended-mkcol',
			'X-Muse-Access': access,
			'MS-Author-Via': 'DAV',
		},
	});
}

interface DestinationInput {
	base: URL;
	connectionId: string;
	resourceKeys: string[];
}

/** Validate and authorize the Destination header for MOVE/COPY. */
function authorizeDestination(ctx: AgentCtx, input: DestinationInput): string {
	const raw = ctx.request.headers.get('destination');
	if (!raw) {
		throw new HttpError(400, 'missing_destination', 'MOVE and COPY require a Destination header.');
	}

	// A Destination is absolute by definition: a relative one would have to be
	// resolved against a URL the caller only guessed at, so it is refused rather
	// than assumed (`relativeTo: ''`).
	const relative = toGatewayPath(raw, { base: input.base, connectionId: input.connectionId, relativeTo: '' });
	if (relative === null) {
		throw new HttpError(400, 'invalid_destination', 'Destination must point inside this connection.');
	}

	const target = normalizePath(relative);
	const decision = ctx.decide(resolveDavPath(target, input.resourceKeys));
	ctx.require(decision, 'write', `This key needs write access to the destination '${target}'.`);

	return new URL(target.replace(/^\//, ''), input.base).toString();
}

/** Map an absolute upstream URL back into a gateway path, when it is inside. */
function rewriteToGateway(absolute: string, base: URL, connectionId: string): string | null {
	let url: URL;
	try {
		url = new URL(absolute);
	} catch {
		return null;
	}
	if (url.origin !== base.origin) return null;
	if (!url.pathname.startsWith(base.pathname)) return null;
	const relative = url.pathname.slice(base.pathname.length);
	return `/api/agent/caldav/${encodeURIComponent(connectionId)}/${relative}${url.search}`;
}
