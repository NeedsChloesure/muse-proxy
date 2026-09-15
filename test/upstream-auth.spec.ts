import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fetchWithStoredAuth } from '../src/lib/upstream-auth';
import { dav } from './dav';
import {
	CALENDAR_HOME,
	CALENDAR_TYPE,
	DAV,
	DISPLAY_NAME,
	PRINCIPAL,
	adminJson,
	davResponse,
	gatewayFetch,
	multistatus,
	seedGateway,
	signUp,
} from './helpers';

const GOOD_PASSWORD = 's3cret-upstream-password';

let cookie = '';

beforeAll(() => dav.install());
afterAll(() => dav.uninstall());

beforeEach(async () => {
	// seedGateway() seeds an account named 'alice', so the console user is not.
	cookie = (await signUp('owner')).cookie;
	dav.reset();
	dav.discoveryDefaults();
});

interface CreateResult {
	data?: {
		test: { ok: boolean; error?: string };
		connection: { status: string; resources: Array<{ resourceKey: string }> };
	};
}

/** Created with the provider's default auth type, which is Basic. */
function connect(overrides: Record<string, unknown> = {}) {
	return adminJson<CreateResult>(cookie, '/api/admin/connections', {
		method: 'POST',
		body: {
			provider: 'caldav',
			label: 'Baikal',
			config: { baseUrl: `${DAV}/` },
			username: 'alice',
			secret: GOOD_PASSWORD,
			...overrides,
		},
	});
}

function authorizations(scheme: string): string[] {
	const prefix = `${scheme.toLowerCase()} `;
	return dav.authorizations.filter((value) => value.toLowerCase().startsWith(prefix));
}

function authParams(header: string): Record<string, string> {
	const params: Record<string, string> = {};
	const pattern = /([A-Za-z][A-Za-z0-9._+-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(header)) !== null) params[match[1]] = match[2] ?? match[3];
	return params;
}

describe('negotiating Digest with a server that refuses Basic', () => {
	it('connects to a Digest-only server without being told to', async () => {
		dav.requireDigest({ username: 'alice', password: GOOD_PASSWORD });

		const { body } = await connect();

		expect(body.data?.test.error).toBeUndefined();
		expect(body.data?.test.ok).toBe(true);
		expect(body.data?.connection.resources.map((resource) => resource.resourceKey)).toContain('calendars/alice/work');
	});

	it('tries the stored scheme once, then answers the challenge from then on', async () => {
		dav.requireDigest({ username: 'alice', password: GOOD_PASSWORD });

		await connect();

		// One Basic attempt is unavoidable: nothing advertises the challenge until
		// a request is refused.
		expect(authorizations('Basic')).toHaveLength(1);
		expect(authorizations('Digest').length).toBeGreaterThan(1);
		// Every later request reuses the negotiated session rather than retrying.
		expect(dav.authorizations.slice(1).every((value) => value.toLowerCase().startsWith('digest '))).toBe(true);
	});

	it('advances the nonce count, so no request looks like a replay', async () => {
		dav.requireDigest({ username: 'alice', password: GOOD_PASSWORD });

		await connect();

		const counts = authorizations('Digest').map((header) => Number.parseInt(authParams(header).nc, 16));
		expect(counts.length).toBeGreaterThan(1);
		expect(new Set(counts).size).toBe(counts.length);
		expect([...counts].sort((a, b) => a - b)).toEqual(counts);
	});

	it('keeps sessions per connection, so one connection cannot borrow another', async () => {
		dav.requireDigest({ username: 'alice', password: GOOD_PASSWORD });

		const good = await connect();
		// Same origin, same username, different password: a cache keyed by origin
		// rather than by connection would wrongly let this succeed.
		const bad = await connect({ secret: 'not-the-password' });

		expect(good.body.data?.test.ok).toBe(true);
		expect(bad.body.data?.test.ok).toBe(false);
	});

	it('reports rejected credentials as rejected, naming the challenge', async () => {
		dav.requireDigest({ username: 'alice', password: 'not-the-password' });

		const { body } = await connect();
		const error = body.data?.test.error ?? '';

		expect(body.data?.test.ok).toBe(false);
		expect(error).toContain('HTTP 401');
		expect(error).toContain('Digest');
		expect(error).toContain('Check the username and password');
	});

	it('does not blame the password for a challenge it cannot compute', async () => {
		dav.challengeWith(
			'Digest realm="BaikalDAV", qop="auth", algorithm=SHA-512-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"',
		);

		const { body } = await connect();
		const error = body.data?.test.error ?? '';

		expect(body.data?.test.ok).toBe(false);
		expect(error).toContain('SHA-512-256');
		expect(error).toContain('cannot compute');
		expect(error).not.toContain('Check the username and password');
	});
});

describe('a Digest server whose endpoint is behind a redirect', () => {
	/**
	 * Baikal's real layout: the web server rewrites /.well-known/caldav to the DAV
	 * endpoint before any DAV authentication is reached, so the redirect is
	 * anonymous and the challenge only appears at the end of the chain.
	 */
	function redirectingServer() {
		dav.stub('PROPFIND', '/', { status: 302, headers: { location: '/admin/' } });
		dav.stub('PROPFIND', '/admin/', {
			status: 200,
			body: '<html><body>Baikal admin</body></html>',
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
		dav.stub('PROPFIND', '/.well-known/caldav', { status: 301, headers: { location: '/dav.php/' } });
		dav.stub('PROPFIND', '/dav.php/', {
			status: 207,
			body: multistatus(davResponse('/dav.php/', PRINCIPAL('/dav.php/principals/alice/'))),
			headers: { 'content-type': 'application/xml; charset=utf-8' },
		});
		dav.stub('PROPFIND', '/dav.php/principals/alice/', {
			status: 207,
			body: multistatus(
				davResponse('/dav.php/principals/alice/', CALENDAR_HOME('/dav.php/calendars/alice/')),
			),
			headers: { 'content-type': 'application/xml; charset=utf-8' },
		});
		dav.stub('PROPFIND', '/dav.php/calendars/alice/', {
			status: 207,
			body: multistatus(davResponse('/dav.php/calendars/alice/work/', CALENDAR_TYPE + DISPLAY_NAME('Work'))),
			headers: { 'content-type': 'application/xml; charset=utf-8' },
		});
	}

	it('connects, re-deriving the digest for the URL that actually answers', async () => {
		redirectingServer();
		dav.requireDigest({
			username: 'alice',
			password: GOOD_PASSWORD,
			exempt: ['/', '/.well-known/caldav'],
		});

		const { body } = await connect();

		expect(body.data?.test.ok).toBe(true);
		expect(body.data?.connection.resources.map((resource) => resource.resourceKey)).toContain(
			'dav.php/calendars/alice/work',
		);

		// The digest is computed for the target that answered, never carried across
		// the hop: a response bound to /.well-known/caldav would be refused with a
		// 400 by a server that checks `uri` against its request line.
		for (const request of dav.seen.filter((entry) => entry.path === '/dav.php/')) {
			if (!request.authorization.toLowerCase().startsWith('digest ')) continue;
			expect(authParams(request.authorization).uri).toBe('/dav.php/');
		}
	});
});

describe('the gateway authenticates upstream the same way', () => {
	it('proxies an agent read, hashing the upstream path rather than the gateway path', async () => {
		const seed = await seedGateway();
		dav.requireDigest({ username: 'alice@example.com', password: GOOD_PASSWORD });
		dav.stub('GET', '/calendars/alice/work/', {
			status: 200,
			body: 'BEGIN:VCALENDAR',
			headers: { 'content-type': 'text/calendar' },
		});

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('BEGIN:VCALENDAR');

		const digest = authorizations('Digest')[0];
		// A Digest response is bound to its request-target. Hashing the path the
		// agent addressed would produce a response the server cannot verify.
		expect(authParams(digest).uri).toBe('/calendars/alice/work/');
		expect(authParams(digest).uri).not.toContain('/api/agent/');
	});

	it('replays a write body when the challenge costs an extra round trip', async () => {
		const seed = await seedGateway();
		dav.requireDigest({ username: 'alice@example.com', password: GOOD_PASSWORD });
		dav.stub('PUT', '/addressbooks/alice/people/x.vcf', { status: 201 });

		const response = await gatewayFetch(seed.connectionId, '/addressbooks/alice/people/x.vcf', seed.token, {
			method: 'PUT',
			headers: { 'content-type': 'text/vcard' },
			body: 'BEGIN:VCARD',
		});

		expect(response.status).toBe(201);

		const writes = dav.seen.filter((request) => request.method === 'PUT');
		expect(writes.length).toBe(2);
		expect(writes[0].body).toBe('BEGIN:VCARD');
		// The authenticated attempt must carry the body too: it is a buffer, not a
		// stream the first attempt already drained.
		expect(writes[1].body).toBe('BEGIN:VCARD');
		expect(writes[1].authorization.toLowerCase().startsWith('digest ')).toBe(true);
	});

	it('replays a REPORT body, since a REPORT is only meaningful with its query', async () => {
		const seed = await seedGateway();
		dav.requireDigest({ username: 'alice@example.com', password: GOOD_PASSWORD });
		dav.stub('REPORT', '/calendars/alice/work/', {
			status: 207,
			body: '<D:multistatus/>',
			headers: { 'content-type': 'application/xml' },
		});

		const query =
			'<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
			'<D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>';

		const response = await gatewayFetch(seed.connectionId, '/calendars/alice/work/', seed.token, {
			method: 'REPORT',
			headers: { 'content-type': 'application/xml' },
			body: query,
		});

		expect(response.status).toBe(207);

		// Two attempts: the refused one, then the authenticated one. Both must
		// carry the query — the server answers a calendar-query from the body, not
		// from the fact that it was asked.
		const reports = dav.seen.filter((request) => request.method === 'REPORT');
		expect(reports.length).toBe(2);
		expect(reports[0].body).toBe(query);
		expect(reports[1].body).toBe(query);
		expect(reports[1].authorization.toLowerCase().startsWith('digest ')).toBe(true);
	});

	it('refuses a write above the replayable limit instead of sending it twice', async () => {
		const seed = await seedGateway();
		dav.requireDigest({ username: 'alice@example.com', password: GOOD_PASSWORD });
		dav.stub('PUT', '/addressbooks/alice/people/big.vcf', { status: 201 });

		const response = await gatewayFetch(seed.connectionId, '/addressbooks/alice/people/big.vcf', seed.token, {
			method: 'PUT',
			headers: { 'content-type': 'text/vcard', 'content-length': String(32 * 1024 * 1024) },
			body: 'BEGIN:VCARD',
		});

		expect(response.status).toBe(413);
		expect(dav.seen).toHaveLength(0);
	});
});

describe('a body that cannot be replayed', () => {
	it('is refused before the first attempt, not after that attempt consumed it', async () => {
		// The gateway buffers the body for any password-authenticated connection,
		// so this is the contract as enforced at the boundary rather than a path a
		// real caller takes. The point is that it fails before anything is sent:
		// a stream consumed by attempt one leaves the Digest retry nothing to send.
		await expect(
			fetchWithStoredAuth({
				url: new URL(`${DAV}/calendars/alice/work/`),
				method: 'PUT',
				headers: new Headers({ 'content-type': 'text/calendar' }),
				body: new ReadableStream(),
				authType: 'basic',
				credentials: { username: 'alice@example.com', secret: GOOD_PASSWORD },
				stateKey: 'stream-body-password',
				allowedOrigin: DAV,
			}),
		).rejects.toThrow(/stream/i);

		expect(dav.seen).toHaveLength(0);
	});

	it('still streams a bearer body, which is never retried', async () => {
		// Nothing is negotiated on a bearer request, so a stream is safe there and
		// must keep working: the refusal above is about replayability, not bodies.
		dav.stub('PUT', '/addressbooks/alice/people/x.vcf', { status: 201 });

		const { response } = await fetchWithStoredAuth({
			url: new URL(`${DAV}/addressbooks/alice/people/x.vcf`),
			method: 'PUT',
			headers: new Headers({ 'content-type': 'text/vcard' }),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('BEGIN:VCARD'));
					controller.close();
				},
			}),
			authType: 'bearer',
			credentials: { username: null, secret: 'streamed-token' },
			stateKey: 'stream-body-bearer',
			allowedOrigin: DAV,
		});

		expect(response.status).toBe(201);
		expect(dav.seen[0].authorization).toBe('Bearer streamed-token');
	});
});
