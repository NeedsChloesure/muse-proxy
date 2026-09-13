import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fetchUpstream } from '../src/lib/upstream';
import { dav } from './dav';
import {
	ADDRESSBOOK_HOME,
	CALENDAR_HOME,
	CALENDAR_TYPE,
	DAV,
	DISPLAY_NAME,
	PRINCIPAL,
	adminJson,
	davResponse,
	multistatus,
	signUp,
} from './helpers';

const XML = { 'content-type': 'application/xml; charset=utf-8' };

let cookie = '';

beforeAll(() => dav.install());
afterAll(() => dav.uninstall());

beforeEach(async () => {
	cookie = (await signUp('alice')).cookie;
	dav.reset();
});

interface CreateResult {
	data?: {
		connection: { status: string; lastError: string | null; resources: Array<{ resourceKey: string }> };
		test: { ok: boolean; error?: string };
	};
}

function connect(baseUrl: string) {
	return adminJson<CreateResult>(cookie, '/api/admin/connections', {
		method: 'POST',
		body: {
			provider: 'caldav',
			label: 'Baikal',
			config: { baseUrl },
			username: 'alice',
			secret: 'correct-horse-battery',
		},
	});
}

function requests(): string[] {
	return dav.seen.map((request) => `${request.method} ${request.path}`);
}

/**
 * A server that mounts DAV under a path, with a web interface at the root.
 *
 * This is Baikal's layout: the root serves the admin UI, /.well-known/caldav is
 * a 301 to /dav.php/ (Baikal's .htaccess does exactly that), and only the
 * /dav.php/ tree answers DAV.
 */
function pathMountedServer() {
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
		headers: XML,
	});
	dav.stub('PROPFIND', '/dav.php/principals/alice/', {
		status: 207,
		body: multistatus(
			davResponse(
				'/dav.php/principals/alice/',
				CALENDAR_HOME('/dav.php/calendars/alice/') + ADDRESSBOOK_HOME('/dav.php/addressbooks/alice/'),
			),
		),
		headers: XML,
	});
	dav.stub('PROPFIND', '/dav.php/calendars/alice/', {
		status: 207,
		body: multistatus(
			davResponse('/dav.php/calendars/alice/', '<D:resourcetype><D:collection/></D:resourcetype>'),
			davResponse('/dav.php/calendars/alice/work/', CALENDAR_TYPE + DISPLAY_NAME('Work')),
		),
		headers: XML,
	});
	dav.stub('PROPFIND', '/dav.php/addressbooks/alice/', {
		status: 207,
		body: multistatus(davResponse('/dav.php/addressbooks/alice/', '<D:resourcetype><D:collection/></D:resourcetype>')),
		headers: XML,
	});
}

describe('discovery through a path-mounted server', () => {
	it('connects when the base URL is the host root and DAV lives under a path', async () => {
		pathMountedServer();
		const { body } = await connect(`${DAV}/`);

		expect(body.data?.test.ok).toBe(true);
		// The collected scope is addressed relative to the configured base, so an
		// agent path resolves back onto /dav.php/ with no special casing.
		expect(body.data?.connection.resources.map((resource) => resource.resourceKey)).toEqual([
			'dav.php/calendars/alice/work',
		]);
	});

	it('keeps PROPFIND and its body across the well-known redirect', async () => {
		pathMountedServer();
		await connect(`${DAV}/`);

		// create() verifies and then discovers, so the endpoint is probed twice.
		const followed = dav.seen.filter((request) => request.path === '/dav.php/');
		expect(followed.length).toBeGreaterThan(0);
		expect(followed.every((request) => request.method === 'PROPFIND')).toBe(true);
		// A bodyless GET is what a degraded redirect would produce, and no DAV
		// server can answer a principal from it.
		expect(followed.every((request) => request.headers['content-type'] !== undefined)).toBe(true);
		expect(requests()).not.toContain('GET /dav.php/');
	});

	it('connects when only the well-known path authenticates', async () => {
		// The web interface at the root demands its own credentials and rejects
		// the DAV ones. That must not be fatal: the user's credentials are
		// correct, they just describe the wrong URL.
		pathMountedServer();
		dav.stub('PROPFIND', '/', {
			status: 401,
			headers: { 'www-authenticate': 'Basic realm="Baikal"' },
		});
		dav.stub('PROPFIND', '/admin/', {
			status: 401,
			headers: { 'www-authenticate': 'Basic realm="Baikal"' },
		});

		const { body } = await connect(`${DAV}/`);
		expect(body.data?.test.ok).toBe(true);
		expect(body.data?.connection.resources.map((resource) => resource.resourceKey)).toEqual([
			'dav.php/calendars/alice/work',
		]);
	});
});

describe('discovery failures name the real cause', () => {
	it('reports the path and realm when the credentials are genuinely rejected', async () => {
		dav.stub('PROPFIND', '/', { status: 401, headers: { 'www-authenticate': 'Basic realm="Baikal"' } });
		dav.stub('PROPFIND', '/.well-known/caldav', { status: 401, headers: { 'www-authenticate': 'Basic realm="Baikal"' } });

		const { body } = await connect(`${DAV}/`);
		const error = body.data?.test.error ?? '';

		expect(body.data?.test.ok).toBe(false);
		expect(error).toContain('HTTP 401');
		expect(error).toContain('realm "Baikal"');
		// The message names the configured URL, which is the part the user can fix.
		expect(error).toContain('at / (');
		// Both entry points were tried before giving up.
		expect(requests()).toContain('PROPFIND /.well-known/caldav');
	});

	it('does not blame the password when the server wants a scheme nobody can send', async () => {
		// Digest is answered by the gateway now; Negotiate is not, and correct
		// credentials still produce 401 for it.
		dav.stub('PROPFIND', '/', { status: 401, headers: { 'www-authenticate': 'Negotiate' } });
		dav.stub('PROPFIND', '/.well-known/caldav', { status: 401, headers: { 'www-authenticate': 'Negotiate' } });

		const { body } = await connect(`${DAV}/`);
		const error = body.data?.test.error ?? '';

		expect(error).toContain('Negotiate');
		expect(error).toContain('cannot be used');
		expect(error).not.toContain('Check the username and password');
	});

	it('says the URL is a web interface when the root serves HTML', async () => {
		dav.stub('PROPFIND', '/', {
			status: 200,
			body: '<html><body>Sign in</body></html>',
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
		dav.stub('PROPFIND', '/.well-known/caldav', { status: 404 });

		const { body } = await connect(`${DAV}/`);
		const error = body.data?.test.error ?? '';

		expect(error).toContain('HTML page');
		expect(error).toContain('not a CalDAV endpoint');
		expect(error).toContain('/dav.php/');
	});
});

describe('redirect semantics', () => {
	function propfind(url: string, method = 'PROPFIND', body: string | null = '<d:propfind/>') {
		return fetchUpstream({
			url: new URL(url),
			method,
			headers: new Headers({ 'content-type': 'application/xml; charset=utf-8' }),
			body,
			allowedOrigin: DAV,
		});
	}

	it('re-issues a PROPFIND as a PROPFIND on 301', async () => {
		dav.stub('PROPFIND', '/old/', { status: 301, headers: { location: '/new/' } });
		dav.stub('PROPFIND', '/new/', { status: 207, body: multistatus(), headers: XML });

		const response = await propfind(`${DAV}/old/`);

		expect(response.status).toBe(207);
		expect(requests()).toEqual(['PROPFIND /old/', 'PROPFIND /new/']);
		expect(dav.seen[1].headers['content-type']).toContain('xml');
	});

	it('re-issues a PUT as a PUT on 307, rather than losing the write', async () => {
		dav.stub('PUT', '/old.ics', { status: 307, headers: { location: '/new.ics' } });
		dav.stub('PUT', '/new.ics', { status: 201 });

		const response = await propfind(`${DAV}/old.ics`, 'PUT', 'BEGIN:VCALENDAR');

		expect(response.status).toBe(201);
		expect(requests()).toEqual(['PUT /old.ics', 'PUT /new.ics']);
	});

	it('degrades to GET for 303, which is what that status means', async () => {
		dav.stub('PROPFIND', '/see/', { status: 303, headers: { location: '/there/' } });
		dav.stub('GET', '/there/', { status: 200, body: 'ok' });

		const response = await propfind(`${DAV}/see/`);

		expect(response.status).toBe(200);
		expect(requests()).toEqual(['PROPFIND /see/', 'GET /there/']);
	});

	it('degrades a POST to GET on 302, and only a POST', async () => {
		dav.stub('POST', '/submit/', { status: 302, headers: { location: '/result/' } });
		dav.stub('GET', '/result/', { status: 200, body: 'ok' });

		await propfind(`${DAV}/submit/`, 'POST', 'x=1');

		expect(requests()).toEqual(['POST /submit/', 'GET /result/']);
	});
});
