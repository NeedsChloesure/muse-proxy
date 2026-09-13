import { describe, expect, it } from 'vitest';

import { assertAllowedBaseUrl, describeBlockedHost, normalizePath, resolveUpstreamUrl, toResourceKey } from '../src/lib/url';

const OPEN = { allowPrivateNetworks: true, allowInsecureHttp: true };
const STRICT = { allowPrivateNetworks: false, allowInsecureHttp: false };

describe('normalizePath', () => {
	it('canonicalises separators and keeps an explicit trailing slash', () => {
		expect(normalizePath('/calendars/alice/work/')).toBe('/calendars/alice/work/');
		expect(normalizePath('/calendars//alice///work')).toBe('/calendars/alice/work');
		expect(normalizePath('calendars/alice')).toBe('/calendars/alice');
		expect(normalizePath('/')).toBe('/');
	});

	it('refuses traversal', () => {
		expect(() => normalizePath('/calendars/../../etc/')).toThrowError(/traversal/i);
		expect(() => normalizePath('/calendars/%2e%2e/secret')).toThrowError(/traversal/i);
		expect(() => normalizePath('/calendars/./x')).toThrowError(/traversal/i);
	});

	it('refuses encoded separators, which could become two segments upstream', () => {
		expect(() => normalizePath('/calendars%2Fetc')).toThrowError(/separators/i);
		expect(() => normalizePath('/calendars%5Cetc')).toThrowError(/separators/i);
		expect(() => normalizePath('/calendars%00')).toThrowError(/separators/i);
	});

	it('refuses protocol-relative paths and malformed encoding', () => {
		expect(() => normalizePath('//evil.example.com/x')).toThrowError(/Protocol-relative/i);
		expect(() => normalizePath('/calendars/%zz')).toThrowError(/malformed/i);
	});

	it('preserves ordinary characters, re-encoding them safely', () => {
		expect(normalizePath('/calendars/alice/work/événement.ics')).toBe('/calendars/alice/work/%C3%A9v%C3%A9nement.ics');
	});
});

describe('toResourceKey', () => {
	it('strips surrounding slashes', () => {
		expect(toResourceKey('/calendars/alice/work/')).toBe('calendars/alice/work');
	});
});

describe('resolveUpstreamUrl', () => {
	it('joins onto the base path', () => {
		const url = resolveUpstreamUrl('https://dav.example.com/remote.php/dav/', '/calendars/alice/work/a.ics', OPEN);
		expect(url.toString()).toBe('https://dav.example.com/remote.php/dav/calendars/alice/work/a.ics');
	});

	it('keeps a trailing slash, because many DAV servers distinguish collection URLs', () => {
		const url = resolveUpstreamUrl('https://dav.example.com/', '/calendars/alice/work/', OPEN);
		expect(url.pathname).toBe('/calendars/alice/work/');
	});

	it('cannot be walked out of the base path', () => {
		expect(() => resolveUpstreamUrl('https://dav.example.com/remote.php/dav/', '/../../admin', OPEN)).toThrowError();
		expect(() => resolveUpstreamUrl('https://dav.example.com/remote.php/dav/', '/%2e%2e/%2e%2e/admin', OPEN)).toThrowError();
	});

	it('rejects an absolute URL supplied as a path', () => {
		// A URL in the path position would replace the origin if it were honoured.
		expect(() => resolveUpstreamUrl('https://dav.example.com/', 'https://evil.example.com/x', OPEN)).toThrowError();
	});

	it('enforces the policy on the base URL itself', () => {
		expect(() => resolveUpstreamUrl('http://dav.example.com/', '/x', STRICT)).toThrowError(/http is disabled/i);
		// The same base is fine once the deployment opts into plain http.
		expect(resolveUpstreamUrl('http://dav.example.com/', '/x', OPEN).toString()).toBe('http://dav.example.com/x');
	});
});

describe('assertAllowedBaseUrl', () => {
	it('accepts a public https server', () => {
		expect(assertAllowedBaseUrl('https://dav.example.com', STRICT).toString()).toBe('https://dav.example.com/');
	});

	it('requires https unless explicitly overridden', () => {
		expect(() => assertAllowedBaseUrl('http://dav.example.com/', STRICT)).toThrowError(/http is disabled/i);
		expect(assertAllowedBaseUrl('http://dav.example.com/', OPEN).toString()).toBe('http://dav.example.com/');
	});

	it('refuses embedded credentials', () => {
		expect(() => assertAllowedBaseUrl('https://user:pass@dav.example.com/', OPEN)).toThrowError(/must not be embedded/i);
	});

	it('refuses a query string or fragment', () => {
		expect(() => assertAllowedBaseUrl('https://dav.example.com/?x=1', OPEN)).toThrowError(/query string/i);
		expect(() => assertAllowedBaseUrl('https://dav.example.com/#a', OPEN)).toThrowError(/query string/i);
	});

	it('blocks private hosts unless the deployment opts in', () => {
		expect(() => assertAllowedBaseUrl('https://192.168.1.10/', STRICT)).toThrowError(/not allowed/i);
		expect(() => assertAllowedBaseUrl('https://localhost:5232/', STRICT)).toThrowError(/not allowed/i);
		// Self-hosters running Radicale on a LAN opt in.
		expect(assertAllowedBaseUrl('https://192.168.1.10/', OPEN).hostname).toBe('192.168.1.10');
	});

	it('rejects non-http schemes', () => {
		expect(() => assertAllowedBaseUrl('ftp://dav.example.com/', OPEN)).toThrowError(/http or https/i);
		expect(() => assertAllowedBaseUrl('not a url', OPEN)).toThrowError(/valid URL/i);
	});
});

describe('describeBlockedHost', () => {
	const blocked = [
		'localhost',
		'api.localhost',
		'radicale.local',
		'box.internal',
		'metadata.google.internal',
		'127.0.0.1',
		'127.1',
		'10.0.0.5',
		'172.16.4.1',
		'172.31.255.254',
		'192.168.0.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'[::1]',
		'::1',
		'fd00::1',
		'fe80::1',
		'::ffff:127.0.0.1',
	];

	// Shorthand forms of loopback that a naive string check would miss.
	const disguised = ['2130706433', '0x7f000001', '0177.0.0.1', '0x7f.1', '127.0.0.1'];

	const allowed = ['dav.example.com', 'caldav.fastmail.com', 'cloud.example.co.uk', '8.8.8.8', '2606:4700::1111'];

	it.each(blocked)('blocks %s', (host) => {
		expect(describeBlockedHost(host)).not.toBeNull();
	});

	it.each(disguised)('blocks the disguised loopback form %s', (host) => {
		expect(describeBlockedHost(host)).not.toBeNull();
	});

	it.each(allowed)('allows %s', (host) => {
		expect(describeBlockedHost(host)).toBeNull();
	});

	it('is case insensitive and tolerates a trailing dot', () => {
		expect(describeBlockedHost('LOCALHOST.')).not.toBeNull();
	});
});
