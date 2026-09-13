/**
 * OpenAPI declaration for the CalDAV provider's agent surface.
 *
 * OpenAPI 3.1 has no way to express DAV methods, so the full method list is
 * published as the `x-muse-dav-methods` extension alongside the standard verbs.
 * This fragment is what /api/agent/openapi.json is built from, and
 * test/docs.spec.ts asserts every declared path is actually routable — which is
 * what keeps the published docs honest.
 */

import type { OpenApiFragment } from '../types';

const PATH_PARAM = {
	name: 'connectionId',
	in: 'path',
	required: true,
	description: 'The CalDAV connection to address, as shown in the frontend.',
	schema: { type: 'string' },
};

const DAV_PATH_PARAM = {
	name: 'path',
	in: 'path',
	required: true,
	description:
		'Path inside the upstream server, relative to the connection base URL. A path, never a URL. Requests are refused unless they resolve to a collection this key has been granted.',
	schema: { type: 'string' },
};

const ACCESS_RESPONSE = {
	description:
		'Denied. The body lists `required`, `effective` and the `permittedResources` this key may use, so a caller can correct itself.',
	content: {
		'application/json': {
			schema: {
				type: 'object',
				properties: {
					error: { type: 'object' },
				},
			},
		},
	},
};

const GATEWAY_OPERATION = {
	parameters: [PATH_PARAM, DAV_PATH_PARAM],
	responses: {
		200: { description: 'Forwarded from the upstream CalDAV/CardDAV server, body and headers intact.' },
		207: { description: 'Multistatus response, forwarded unchanged from the upstream server.' },
		401: { description: 'Missing or expired API key.' },
		403: ACCESS_RESPONSE,
		502: { description: 'The upstream server could not be reached.' },
	},
	'x-muse-required-access': 'read for GET/HEAD/PROPFIND/REPORT; write for PUT/POST/DELETE/MKCOL/MKCALENDAR/PROPPATCH/MOVE/COPY',
	'x-muse-dav-methods': ['OPTIONS', 'GET', 'HEAD', 'PROPFIND', 'REPORT', 'PUT', 'POST', 'DELETE', 'MKCOL', 'MKCALENDAR', 'PROPPATCH', 'MOVE', 'COPY'],
};

export const caldavOpenApi: OpenApiFragment = {
	paths: {
		'/api/agent/caldav/{connectionId}/{path}': {
			description:
				'Transparent CalDAV/CardDAV gateway. Credentials for the upstream server are injected by Muse Proxy and never exposed to the caller. ' +
				'Request bodies are forwarded, so a REPORT query or PROPFIND property set reaches the server as sent. ' +
				'Because a REPORT body names its own targets, every DAV:href it contains is authorized individually as well as the request path. ' +
				'OPTIONS is answered locally and reports the access level this key holds in the X-Muse-Access header.',
			get: { ...GATEWAY_OPERATION, summary: 'Read a resource (calendar object, collection or property set)', tags: ['caldav'] },
			head: { ...GATEWAY_OPERATION, summary: 'Read resource metadata', tags: ['caldav'] },
			put: { ...GATEWAY_OPERATION, summary: 'Create or replace a resource (requires write access)', tags: ['caldav'] },
			post: { ...GATEWAY_OPERATION, summary: 'Post to a collection (requires write access)', tags: ['caldav'] },
			delete: { ...GATEWAY_OPERATION, summary: 'Delete a resource (requires write access)', tags: ['caldav'] },
			options: {
				...GATEWAY_OPERATION,
				summary: 'Capability probe, answered locally',
				description:
					'Answered by Muse Proxy without contacting the upstream server. The Allow header lists only the methods this key may use on this path, and X-Muse-Access reports the effective level (none, read or write).',
				tags: ['caldav'],
			},
		},
	},
};
