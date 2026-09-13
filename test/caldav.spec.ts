import { env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/lib/crypto';
import * as repo from '../src/db/repo';
import { resolveDavPath } from '../src/providers/caldav/resolve';
import { dav } from './dav';
import { DAV, gatewayFetch, seedGateway, url, type SeededGateway } from './helpers';

let seed: SeededGateway;

beforeAll(() => dav.install());
afterAll(() => dav.uninstall());

beforeEach(async () => {
	seed = await seedGateway();
	dav.reset();
});

/**
 * DAV path resolution lives with the provider rather than in the permission
 * core, which is now protocol-neutral. These cases moved here with it.
 */
describe('resolveDavPath', () => {
	const keys = ['calendars/alice/work', 'calendars/alice/home'];

	it('matches a collection and its descendants', () => {
		expect(resolveDavPath('/calendars/alice/work/', keys)).toMatchObject({
			resourceKey: 'calendars/alice/work',
			connectionScope: false,
		});
		expect(resolveDavPath('/calendars/alice/work/event.ics', keys)).toMatchObject({
			resourceKey: 'calendars/alice/work',
		});
	});

	it('prefers the longest matching collection', () => {
		const nested = ['calendars/alice', 'calendars/alice/work'];
		expect(resolveDavPath('/calendars/alice/work/x.ics', nested).resourceKey).toBe('calendars/alice/work');
		expect(resolveDavPath('/calendars/alice/other/x.ics', nested).resourceKey).toBe('calendars/alice');
	});

	it('treats a prefix that is not a path boundary as unrelated', () => {
		// 'calendars/alice/workshop' must not match 'calendars/alice/work'.
		const resolution = resolveDavPath('/calendars/alice/workshop/', ['calendars/alice/work']);
		expect(resolution.resourceKey).toBeNull();
		expect(resolution.connectionScope).toBe(false);
	});

	it('recognises enumerating paths as spanning the connection', () => {
		expect(resolveDavPath('/', keys)).toMatchObject({ resourceKey: null, connectionScope: true });
		expect(resolveDavPath('/calendars/alice/', keys)).toMatchObject({ resourceKey: null, connectionScope: true });
	});

	it('explains an unrelated path rather than calling it an enumeration', () => {
		const resolution = resolveDavPath('/principals/bob/', keys);
		expect(resolution).toMatchObject({ resourceKey: null, connectionScope: false });
		expect(resolution.reason).toContain('does not address');
	});
});

describe('read access', () => {
	it('forwards a PROPFIND inside a granted collection and injects the stored credentials', async () => {
		dav.stub('PROPFIND', '/calendars/alice/work/', {
			status: 207,
			body: '<D:multistatus/>',
			headers: { 'content-type': 'application/xml', etag: '"abc"' },
		});

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'PROPFIND',
			headers: { depth: '1' },
		});

		expect(response.status).toBe(207);
		expect(await response.text()).toContain('multistatus');
		expect(response.headers.get('x-muse-access')).toBe('read');
		expect(response.headers.get('x-muse-resource')).toBe('calendars/alice/work');
		expect(response.headers.get('X-Muse-Notices')).toBe('0');

		expect(dav.seen).toHaveLength(1);
		expect(dav.seen[0]).toMatchObject({ method: 'PROPFIND', path: '/calendars/alice/work/' });
		expect(dav.seen[0].authorization).toBe(`Basic ${btoa('alice@example.com:s3cret-upstream-password')}`);
		expect(dav.seen[0].headers.depth).toBe('1');
	});

	it('answers an OPTIONS probe locally, without contacting upstream', async () => {
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, { method: 'OPTIONS' });

		expect(response.status).toBe(204);
		expect(response.headers.get('x-muse-access')).toBe('read');
		// Advertises only what this key may actually do here.
		expect(response.headers.get('allow')).toContain('PROPFIND');
		expect(response.headers.get('allow')).not.toContain('PUT');
		expect(response.headers.get('dav')).toContain('calendar-access');
		expect(dav.seen).toEqual([]);
	});
});

const XML_TYPE = 'application/xml; charset=utf-8';

/** A calendar-multiget, the REPORT whose targets live in the body. */
function multiget(...hrefs: string[]): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
		'<D:prop><D:getetag/></D:prop>' +
		hrefs.map((href) => `<D:href>${href}</D:href>`).join('') +
		'</C:calendar-multiget>'
	);
}

const CALENDAR_QUERY =
	'<?xml version="1.0" encoding="utf-8"?>' +
	'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
	'<D:prop><D:getetag/></D:prop>' +
	'<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
	'<C:time-range start="20260101T000000Z" end="20260201T000000Z"/>' +
	'</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>';

/**
 * REPORT is a read method that carries its query in the body, so a gateway that
 * forwards the method but drops the body does not degrade the request — it
 * changes the question. And the hrefs a multiget names are targets in their own
 * right, which the request URL says nothing about.
 */
describe('REPORT', () => {
	it('forwards the query body, which is the request', async () => {
		dav.stub('REPORT', '/calendars/alice/work/', { status: 207, body: '<D:multistatus/>', headers: { 'content-type': XML_TYPE } });

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { depth: '1', 'content-type': XML_TYPE },
			body: CALENDAR_QUERY,
		});

		expect(response.status).toBe(207);
		expect(response.headers.get('x-muse-access')).toBe('read');
		expect(dav.seen[0].headers.depth).toBe('1');
		expect(dav.seen[0].body).toContain('time-range');
		expect(dav.seen[0].body).toBe(CALENDAR_QUERY);
	});

	it('forwards a PROPFIND property set instead of silently asking for everything', async () => {
		dav.stub('PROPFIND', '/calendars/alice/work/', { status: 207, body: '<D:multistatus/>', headers: { 'content-type': XML_TYPE } });

		const body = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>';
		await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'PROPFIND',
			headers: { 'content-type': XML_TYPE },
			body,
		});

		expect(dav.seen[0].body).toBe(body);
	});

	it('allows a multiget whose hrefs are all inside the granted collection, in any of the forms a client may use', async () => {
		dav.stub('REPORT', '/calendars/alice/work/', { status: 207, body: '<D:multistatus/>', headers: { 'content-type': XML_TYPE } });

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': XML_TYPE },
			body: multiget(
				'/calendars/alice/work/a.ics',
				`${DAV}/calendars/alice/work/b.ics`,
				`/api/agent/caldav/${seed.connectionId}/calendars/alice/work/c.ics`,
				'd.ics',
			),
		});

		expect(response.status).toBe(207);
		expect(dav.seen).toHaveLength(1);
	});

	it('refuses a multiget naming a collection the key cannot read, without contacting upstream', async () => {
		// The connection permits this calendar; this key has no grant on it. The
		// upstream holds the user's own credentials, so it would have answered.
		await repo.upsertResource(env.DB, {
			id: 'res-private',
			connectionId: seed.connectionId,
			resourceKey: 'calendars/alice/private',
			kind: 'calendar',
			displayName: 'Private',
			metaJson: '{}',
			now: Date.now(),
		});
		await repo.setResourceAccess(env.DB, 'res-private', 'read');

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': XML_TYPE },
			body: multiget('/calendars/alice/work/a.ics', '/calendars/alice/private/secret.ics'),
		});

		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { code: string; message: string; details: { permittedResources: string[] } } };
		expect(body.error.code).toBe('insufficient_access');
		expect(body.error.message).toContain('secret.ics');
		expect(body.error.details.permittedResources).toContain('calendars/alice/work');
		// Nothing reached upstream, so no object was returned for a calendar the
		// key was never granted.
		expect(dav.seen).toEqual([]);
	});

	it('refuses an href that does not resolve into this connection', async () => {
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': XML_TYPE },
			body: multiget('https://evil.example.com/calendars/alice/work/a.ics'),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_report_href');
		expect(dav.seen).toEqual([]);
	});

	it('refuses a target it can see but cannot read, rather than assuming there is none', async () => {
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': XML_TYPE },
			body: '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:href/></C:calendar-multiget>',
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_report');
		expect(dav.seen).toEqual([]);
	});

	it('refuses an entity reference the parser left unexpanded', async () => {
		// An external-DTD entity stays literal here, so it names nothing we can
		// authorize — while a server that resolves entities would act on a real
		// resource.
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': XML_TYPE },
			body: multiget('&e;'),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_report_href');
		expect(dav.seen).toEqual([]);
	});

	it('refuses encoded traversal in an href', async () => {
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': XML_TYPE },
			body: multiget('/calendars/alice/work/..%2f..%2fprivate/secret.ics'),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_path');
		expect(dav.seen).toEqual([]);
	});
});

describe('the two permission layers intersect', () => {
	it('refuses a write the connection ceiling forbids, even though the key grant allows it', async () => {
		// calendars/alice/work: connection read, key grant write. The narrower wins.
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/new.ics', seed.token, {
			method: 'PUT',
			headers: { 'content-type': 'text/calendar' },
			body: 'BEGIN:VCALENDAR',
		});

		expect(response.status).toBe(403);
		const body = (await response.json()) as {
			error: { code: string; details: { required: string; effective: string; permittedResources: string[] } };
		};
		expect(body.error.code).toBe('insufficient_access');
		expect(body.error.details.required).toBe('write');
		expect(body.error.details.effective).toBe('read');
		// Guides the caller to a collection it can actually write. Resource keys are
		// reported in the core's canonical form; the mount prefix is the caller's.
		expect(body.error.details.permittedResources).toEqual(['addressbooks/alice/people']);
		expect(dav.seen).toEqual([]);
	});

	it('allows a write where both layers agree', async () => {
		dav.stub('PUT', '/addressbooks/alice/people/new.vcf', { status: 201, headers: { etag: '"1"' } });

		const response = await gatewayFetch(seed.connectionId, '/addressbooks/alice/people/new.vcf', seed.token, {
			method: 'PUT',
			headers: { 'content-type': 'text/vcard' },
			body: 'BEGIN:VCARD',
		});

		expect(response.status).toBe(201);
		expect(response.headers.get('x-muse-access')).toBe('write');
		expect(dav.seen[0].authorization).toContain('Basic ');
	});

	it('refuses a collection the connection disables entirely, whatever the key asks for', async () => {
		await repo.upsertResource(env.DB, {
			id: 'res-private',
			connectionId: seed.connectionId,
			resourceKey: 'calendars/alice/private',
			kind: 'calendar',
			displayName: 'Private',
			metaJson: '{}',
			now: Date.now(),
		});
		await repo.replaceGrants(env.DB, 'key-1', [
			{ id: 'g1', connectionId: seed.connectionId, resourceKey: 'calendars/alice/private', maxAccess: 'write' },
		]);

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/private/', seed.token, { method: 'GET' });
		expect(response.status).toBe(403);
	});
});

describe('enumeration is refused, not filtered', () => {
	it('refuses a root PROPFIND without a wildcard grant', async () => {
		const response = await gatewayFetch(seed.connectionId, '/', seed.token, { method: 'PROPFIND', headers: { depth: '1' } });

		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { details: { reason: string; permittedResources: string[] } } };
		expect(body.error.details.reason).toContain('wildcard');
		expect([...body.error.details.permittedResources].sort()).toEqual(['addressbooks/alice/people', 'calendars/alice/work']);
		// Nothing reached upstream, so no collection names or etags leaked.
		expect(dav.seen).toEqual([]);
	});

	it('allows a root PROPFIND once the key holds a wildcard grant and every collection is permitted', async () => {
		await repo.setResourceAccess(env.DB, 'res-work', 'write');
		await repo.replaceGrants(env.DB, 'key-1', [{ id: 'g1', connectionId: seed.connectionId, resourceKey: '*', maxAccess: 'write' }]);
		dav.stub('PROPFIND', '/', { status: 207, body: '<D:multistatus/>', headers: { 'content-type': 'application/xml' } });

		const response = await gatewayFetch(seed.connectionId, '/', seed.token, { method: 'PROPFIND', headers: { depth: '1' } });
		expect(response.status).toBe(207);
		expect(dav.seen).toHaveLength(1);
	});

	it('still refuses enumeration when a wildcard grant meets a partially permitted connection', async () => {
		// people is write, work is read; a wildcard grant cannot make the scope
		// uniform, so enumerating would expose a collection the ACL does not clear.
		await repo.replaceGrants(env.DB, 'key-1', [{ id: 'g1', connectionId: seed.connectionId, resourceKey: '*', maxAccess: 'write' }]);
		dav.stub('PROPFIND', '/', { status: 207, body: '<D:multistatus/>', headers: { 'content-type': 'application/xml' } });

		const response = await gatewayFetch(seed.connectionId, '/', seed.token, { method: 'PROPFIND' });
		// Both collections are readable, so the read-level enumeration is allowed...
		expect(response.status).toBe(207);

		// ...but a request needing write across the connection is not.
		await repo.setResourceAccess(env.DB, 'res-people', 'none');
		const refused = await gatewayFetch(seed.connectionId, '/', seed.token, { method: 'PROPFIND' });
		expect(refused.status).toBe(403);
	});

	it('refuses a path that addresses no collection', async () => {
		const response = await gatewayFetch(seed.connectionId, '/principals/bob/', seed.token, { method: 'GET' });
		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { details: { reason: string } } };
		expect(body.error.details.reason).toContain('does not address');
	});
});

describe('path safety', () => {
	it('normalises encoded traversal so it cannot reach a collection', async () => {
		// The URL parser resolves "%2e%2e" segments before the Worker sees them,
		// so this collapses to /calendars/admin — which addresses no collection.
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/%2e%2e/%2e%2e/admin', seed.token, { method: 'GET' });

		expect(response.status).toBe(403);
		expect(dav.seen).toEqual([]);
	});

	it('rejects an absolute URL in the path position', async () => {
		const response = await gatewayFetch(seed.connectionId, '/https://evil.example.com/x', seed.token, { method: 'GET' });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe('invalid_path');
		expect(dav.seen).toEqual([]);
	});

	it('rejects an unsupported method', async () => {
		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, { method: 'ACL' });
		expect(response.status).toBe(405);
	});
});

describe('MOVE and COPY authorise both ends', () => {
	it('requires write on the destination, not just the source', async () => {
		const response = await gatewayFetch(seed.connectionId, '/addressbooks/alice/people/x.vcf', seed.token, {
			method: 'MOVE',
			headers: { destination: '/calendars/alice/work/x.vcf' },
		});

		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain('destination');
		expect(dav.seen).toEqual([]);
	});

	it('refuses a destination outside the connection', async () => {
		const response = await gatewayFetch(seed.connectionId, '/addressbooks/alice/people/x.vcf', seed.token, {
			method: 'MOVE',
			headers: { destination: 'https://evil.example.com/x.vcf' },
		});
		expect(response.status).toBe(400);
		expect(dav.seen).toEqual([]);
	});

	it('rewrites an in-connection destination to the upstream URL', async () => {
		dav.stub('MOVE', '/addressbooks/alice/people/x.vcf', { status: 201 });

		const response = await gatewayFetch(seed.connectionId, '/addressbooks/alice/people/x.vcf', seed.token, {
			method: 'MOVE',
			headers: { destination: `/api/agent/caldav/${seed.connectionId}/addressbooks/alice/people/y.vcf` },
		});

		expect(response.status).toBe(201);
		expect(dav.seen[0].headers.destination).toBe(`${DAV}/addressbooks/alice/people/y.vcf`);
	});
});

describe('redirects', () => {
	it('rewrites an upstream redirect back into gateway coordinates', async () => {
		dav.stub('PROPFIND', '/calendars/alice/work/', {
			status: 301,
			headers: { location: `${DAV}/calendars/alice/work/moved/` },
		});

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, { method: 'PROPFIND' });
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe(`/api/agent/caldav/${seed.connectionId}/calendars/alice/work/moved/`);
	});
});

describe('response hygiene', () => {
	it('strips upstream cookies and never leaks the stored password', async () => {
		dav.stub('GET', '/calendars/alice/work/event.ics', {
			status: 200,
			body: 'BEGIN:VCALENDAR',
			headers: { 'content-type': 'text/calendar', 'set-cookie': 'upstream_session=abc123; Path=/' },
		});

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/event.ics', seed.token);

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toBeNull();
		const text = await response.text();
		expect(text).not.toContain('s3cret-upstream-password');
		expect(text).not.toContain('upstream_session');
	});
});

describe('key lifecycle', () => {
	it('refuses a deleted key', async () => {
		await repo.deleteApiKey(env.DB, 'key-1');
		expect((await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, { method: 'PROPFIND' })).status).toBe(401);
	});

	it('refuses an expired key', async () => {
		await repo.updateApiKey(env.DB, 'key-1', { expiresAt: Date.now() - 1000 });
		expect((await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, { method: 'PROPFIND' })).status).toBe(401);
	});

	it('refuses a key with no grant on the connection', async () => {
		const other = crypto.randomUUID();
		const existing = (await repo.getConnection(env.DB, seed.connectionId))!;
		await repo.createConnection(env.DB, {
			id: other,
			accountId: seed.accountId,
			provider: 'caldav',
			label: 'Other',
			authType: existing.authType,
			username: existing.username,
			secretCiphertext: existing.secretCiphertext,
			secretHint: existing.secretHint,
			configJson: existing.configJson,
			now: Date.now(),
		});

		const response = await gatewayFetch(other, '/calendars/alice/work/', seed.token, { method: 'PROPFIND' });
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe('no_grant');
	});

	it('404s an unknown connection', async () => {
		expect((await gatewayFetch('does-not-exist', '/calendars/alice/work/', seed.token, { method: 'PROPFIND' })).status).toBe(404);
	});

	it('rejects a connection id that is not valid percent-encoding', async () => {
		// The id comes straight off the request line. Decoding it used to throw a
		// URIError out of the router, which is a malformed request, not a fault of
		// this Worker.
		const response = await gatewayFetch('%', '/calendars/alice/work/', seed.token, { method: 'PROPFIND' });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_path');
	});
});

describe('the agent API requires a key', () => {
	it('rejects an unauthenticated gateway request', async () => {
		const response = await SELF.fetch(url(`/api/agent/caldav/${seed.connectionId}/calendars/alice/work/`), { method: 'PROPFIND' });
		expect(response.status).toBe(401);
	});

	it('stores only the hash of the key', async () => {
		expect(await repo.getApiKeyByTokenHash(env.DB, await sha256Hex(seed.token))).toMatchObject({ id: 'key-1' });
	});
});
