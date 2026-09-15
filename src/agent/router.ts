/**
 * The agent API.
 *
 * Everything a program does goes through here. Each service owns its own URL
 * space under /api/agent/<service>/, so a provider can expose whatever shape
 * suits it; the router's job is authentication, provider dispatch and notice
 * signalling.
 */

import { configFrom } from '../config';
import {
	countPendingNoticesForKey,
	listConnections,
	listGrantsForKey,
	listResourcesForConnections,
	touchApiKey,
	listPendingAgentNotices,
	deleteAgentNotices,
} from '../db/repo';
import { isKeyUsable, resolveAgentIdentity } from '../auth/middleware';
import {
	agentJson,
	corsPreflight,
	HttpError,
	isCorsOriginAllowed,
	json,
	notFound,
	problem,
	toErrorResponse,
	withAgentHeaders,
} from '../lib/http';
import { readJson, requiredArray } from '../lib/validate';
import { accessForResource, decideAccess, type GrantEntry, type ScopeEntry } from '../lib/access';
import { requireAccess, resolveConnectionRoute } from '../providers/gateway';
import { API_VERSION } from '../types';
import { allProviders, getProvider } from '../providers/registry';
import { maybeEmitApiVersionNotice } from './notices';

const AGENT_ROOT = '/api/agent';
const CORS_AGENT_METHODS = [
	'GET',
	'HEAD',
	'POST',
	'PUT',
	'DELETE',
	'OPTIONS',
	'PROPFIND',
	'REPORT',
	'MKCOL',
	'MKCALENDAR',
	'PROPPATCH',
	'MOVE',
	'COPY',
	'LOCK',
	'UNLOCK',
];

export async function handleAgentRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const config = configFrom(env);
	const corsOrigin = isCorsOriginAllowed(request.headers.get('origin'), config.agentCorsOrigin);

	try {
		if (request.method === 'OPTIONS' && request.headers.get('access-control-request-method')) {
			if (!corsOrigin) throw new HttpError(403, 'cors_not_allowed', 'This origin is not allowed to call the agent API.');
			return corsPreflight(request.headers.get('origin') ?? '', corsOrigin, CORS_AGENT_METHODS);
		}

		const response = await routeAgent(request, env, ctx);
		return corsOrigin ? applyCors(response, corsOrigin) : response;
	} catch (error) {
		const response = toErrorResponse(error);
		return corsOrigin ? applyCors(response, corsOrigin) : response;
	}
}

function applyCors(response: Response, origin: string): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', origin);
	headers.set('Access-Control-Expose-Headers', 'X-Muse-Api-Version, X-Muse-Notices, X-Muse-Notices-Url');
	headers.append('Vary', 'Origin');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function routeAgent(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const path = new URL(request.url).pathname;

	// Announce a new API version to agents on the first request after a deploy.
	ctx.waitUntil(maybeEmitApiVersionNotice(env));

	if (path === AGENT_ROOT || path === AGENT_ROOT + '/') return catalog(request, env, ctx);
	if (path === `${AGENT_ROOT}/openapi.json`) return json(openApiDocument());

	if (path === `${AGENT_ROOT}/notices`) {
		if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET to read notices.');
		return pendingNotices(request, env, ctx);
	}
	if (path === `${AGENT_ROOT}/notices/ack`) {
		if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST { ids: [...] } to acknowledge notices.');
		return acknowledgeNotices(request, env, ctx);
	}

	if (!path.startsWith(AGENT_ROOT + '/')) return notFound();

	const rest = path.slice(AGENT_ROOT.length + 1);
	const slash = rest.indexOf('/');
	const serviceType = slash === -1 ? rest : rest.slice(0, slash);
	const provider = getProvider(serviceType);
	if (!provider) {
		throw new HttpError(404, 'unknown_service', `No service named '${serviceType}'.`, { services: allProviders().map((p) => p.type) });
	}

	// The published spec for a service is public: it contains no account data,
	// and requiring a key to read the documentation would defeat its purpose.
	if (slash !== -1 && rest.slice(slash + 1) === 'openapi.json') {
		return json({
			openapi: '3.1.0',
			info: { title: `Muse Proxy — ${provider.displayName}`, version: API_VERSION },
			paths: provider.openapi().paths,
			...(provider.openapi().components ? { components: provider.openapi().components } : {}),
		});
	}

	// Everything else needs a key, and the key is resolved before dispatch so an
	// unknown connection is never distinguishable from an unauthorized one.
	const identity = await resolveAgentIdentity(env, request);
	const pending = await countPendingNoticesForKey(env.DB, identity.key.id);

	// The router owns <connectionId> routing and loads both permission layers, so
	// a provider never queries for a connection and cannot forget account scoping.
	const route = await resolveConnectionRoute(env, identity.key, identity.account, provider, slash === -1 ? rest : rest.slice(slash + 1));

	const result = await provider.handle({
		env,
		request,
		key: identity.key,
		account: identity.account,
		connection: route.connection,
		scope: route.scope,
		grants: route.grants,
		rawPath: route.rawPath,
		decide: (resolution) => decideAccess(route.scope, route.grants, resolution),
		require: (decision, required, message) =>
			requireAccess({ scope: route.scope, grants: route.grants, decision, required, message }),
	});

	ctx.waitUntil(touchApiKey(env.DB, identity.key.id, Date.now()));

	return withAgentHeaders(result.response, { pendingNotices: pending });
}

/** Capability handshake: what exists, and what this key can reach. */
async function catalog(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const services = allProviders().map((provider) => ({
		type: provider.type,
		displayName: provider.displayName,
		summary: provider.summary,
		mount: `${AGENT_ROOT}/${provider.type}`,
		docsUrl: provider.docsPath,
		openapiUrl: provider.openapiPath,
	}));

	const base = {
		docsUrl: '/docs/',
		changelogUrl: '/docs/changelog.html',
		openapiUrl: `${AGENT_ROOT}/openapi.json`,
		noticesUrl: `${AGENT_ROOT}/notices`,
		services,
	};

	if (!request.headers.get('authorization')) {
		return agentJson(
			{
				...base,
				authenticated: false,
				hint: 'Send `Authorization: Bearer muse_...` to see the connections and resources this key may reach.',
			},
			[],
		);
	}

	const identity = await resolveAgentIdentity(env, request);
	const connections = await listConnections(env.DB, identity.account.id);
	const grants = await listGrantsForKey(env.DB, identity.key.id);
	const resources = await listResourcesForConnections(
		env.DB,
		connections.map((connection) => connection.id),
	);
	const notices = await listPendingAgentNotices(env.DB, identity.key.id, 20);

	const byConnection = new Map<string, ScopeEntry[]>();
	for (const resource of resources) {
		const entries = byConnection.get(resource.connectionId) ?? [];
		entries.push({ resourceKey: resource.resourceKey, maxAccess: resource.maxAccess });
		byConnection.set(resource.connectionId, entries);
	}

	const reachable = connections
		.filter((connection) => grants.some((grant) => grant.connectionId === connection.id))
		.map((connection) => {
			const scope = byConnection.get(connection.id) ?? [];
			const keyGrants: GrantEntry[] = grants
				.filter((grant) => grant.connectionId === connection.id)
				.map((grant) => ({ resourceKey: grant.resourceKey, maxAccess: grant.maxAccess }));

			return {
				id: connection.id,
				label: connection.label,
				provider: connection.provider,
				status: connection.status,
				mount: `${AGENT_ROOT}/${connection.provider}/${connection.id}/`,
				wildcard: keyGrants.some((grant) => grant.resourceKey === '*'),
				resources: scope.map((entry) => ({
					resourceKey: entry.resourceKey,
					kind: resources.find((r) => r.connectionId === connection.id && r.resourceKey === entry.resourceKey)?.kind ?? 'unknown',
					displayName:
						resources.find((r) => r.connectionId === connection.id && r.resourceKey === entry.resourceKey)?.displayName ?? entry.resourceKey,
					access: accessForResource(scope, keyGrants, entry.resourceKey),
				})),
			};
		});

	return agentJson(
		{
			...base,
			authenticated: true,
			key: { id: identity.key.id, name: identity.key.name, prefix: identity.key.prefix, expiresAt: identity.key.expiresAt },
			connections: reachable,
		},
		notices,
	);
}

async function pendingNotices(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const identity = await resolveAgentIdentity(env, request);
	const notices = await listPendingAgentNotices(env.DB, identity.key.id);

	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: {
			pending: notices.length,
			notices: notices.map((notice) => ({
				id: notice.id,
				kind: notice.kind,
				severity: notice.severity,
				title: notice.title,
				body: notice.body,
				connectionId: notice.connectionId,
				resourceKey: notice.resourceKey,
				createdAt: notice.createdAt,
				details: safeJson(notice.metaJson),
			})),
			hint: 'Report anything that affects your work to the human you are acting for, then POST /api/agent/notices/ack.',
		},
	});
}

async function acknowledgeNotices(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const identity = await resolveAgentIdentity(env, request);
	const body = await readJson(request);
	const ids = requiredArray(body, 'ids', 200).map((value) => {
		if (typeof value !== 'string') throw new HttpError(400, 'invalid_request', "'ids' must be an array of notice ids.");
		return value;
	});

	await deleteAgentNotices(env.DB, identity.key.id, ids);
	const remaining = await countPendingNoticesForKey(env.DB, identity.key.id);
	ctx.waitUntil(touchApiKey(env.DB, identity.key.id, Date.now()));
	return agentJson({ acknowledged: ids.length, pending: remaining }, []);
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

export function openApiDocument(): unknown {
	const paths: Record<string, unknown> = {
		[AGENT_ROOT]: {
			get: {
				summary: 'Service catalog and this key’s reachable connections',
				description:
					'Without a key, lists the available services. With `Authorization: Bearer`, also lists the connections and resources this key may reach and the effective access level for each.',
				tags: ['core'],
				responses: { 200: { description: 'Catalog' }, 401: { description: 'Invalid key' } },
			},
		},
		[`${AGENT_ROOT}/openapi.json`]: {
			get: { summary: 'This specification', tags: ['core'], responses: { 200: { description: 'OpenAPI document' } } },
		},
		[`${AGENT_ROOT}/notices`]: {
			get: {
				summary: 'Pending notices for this key',
				description:
					'Notices tell an agent that its access changed, credentials were rotated, or the API version moved. They should be surfaced to the human the agent acts for.',
				tags: ['core'],
				responses: { 200: { description: 'Pending notices' }, 401: { description: 'Invalid key' } },
			},
		},
		[`${AGENT_ROOT}/notices/ack`]: {
			post: {
				summary: 'Acknowledge notices',
				tags: ['core'],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } },
						},
					},
				},
				responses: { 200: { description: 'Acknowledged' }, 401: { description: 'Invalid key' } },
			},
		},
	};

	for (const provider of allProviders()) {
		Object.assign(paths, provider.openapi().paths);
	}

	return {
		openapi: '3.1.0',
		info: {
			title: 'Muse Proxy agent API',
			version: API_VERSION,
			description:
				'Scoped, revocable access to services that normally require a username and password. ' +
				'Access is the intersection of the connection owner’s per-collection permissions and the grants attached to your API key.',
		},
		paths,
	};
}

export { isKeyUsable, problem };
