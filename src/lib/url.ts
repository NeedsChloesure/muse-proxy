/**
 * Path normalization and the SSRF boundary.
 *
 * Agents address an HTTP upstream with a PATH, never a URL. This module is what
 * makes that safe: it canonicalises the path, refuses traversal, and joins it
 * onto a provider-supplied base URL while asserting the result never leaves that
 * origin.
 *
 * The base URL is provider config (CalDAV's `baseUrl`), not a core column, so a
 * non-HTTP provider uses a host/port check of its own instead.
 */

import { HttpError } from './http';

export interface BaseUrlPolicy {
	allowPrivateNetworks: boolean;
	allowInsecureHttp: boolean;
}

/** Reject anything that could escape the base path or smuggle a second URL. */
export function normalizePath(input: string): string {
	if (!input.startsWith('/')) input = '/' + input;
	if (input.startsWith('//')) {
		throw new HttpError(400, 'invalid_path', 'Protocol-relative paths are not allowed.');
	}
	// An absolute URL in the path position is a mistake worth naming explicitly,
	// rather than quietly re-encoding into a meaningless path. The leading slash
	// is stripped first because a gateway path arrives as /<path>, so a smuggled
	// URL shows up as /https://host/x.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input.slice(1))) {
		throw new HttpError(400, 'invalid_path', 'Supply a path, not a URL. The upstream origin comes from the connection.');
	}

	const hadTrailingSlash = input.endsWith('/');
	const segments = input.split('/').filter((segment) => segment.length > 0);
	const cleaned = segments.map(normalizeSegment);
	const path = '/' + cleaned.join('/');

	if (path === '/') return '/';
	return hadTrailingSlash ? path + '/' : path;
}

function normalizeSegment(segment: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		throw new HttpError(400, 'invalid_path', 'Path contains malformed percent-encoding.');
	}
	if (decoded === '' || decoded === '.' || decoded === '..') {
		throw new HttpError(400, 'invalid_path', 'Path traversal is not allowed.');
	}
	// An encoded slash would let a single segment become two after upstream
	// decoding, which is exactly the ambiguity traversal attacks rely on.
	if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
		throw new HttpError(400, 'invalid_path', 'Path segments may not contain separators.');
	}
	return encodeURIComponent(decoded);
}

/** Collection key: the normalized path with no leading or trailing slash. */
export function toResourceKey(path: string): string {
	return normalizePath(path).replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Join an agent-supplied path onto a provider-supplied base URL.
 *
 * Throws if the result is not on the same origin, not inside the base path, or
 * if the base_url itself violates the SSRF policy.
 */
export function resolveUpstreamUrl(baseUrl: string, requestPath: string, policy: BaseUrlPolicy): URL {
	const base = assertAllowedBaseUrl(baseUrl, policy);
	const path = normalizePath(requestPath);
	const relative = path.replace(/^\//, '');
	const url = new URL(relative, base);

	if (url.origin !== base.origin) {
		throw new HttpError(400, 'invalid_path', 'Resolved URL left the configured origin.');
	}
	if (!url.pathname.startsWith(base.pathname)) {
		throw new HttpError(400, 'invalid_path', 'Resolved URL left the configured base path.');
	}
	// Preserve an explicit trailing slash: many DAV servers distinguish a
	// collection URL from an item URL by it.
	if (path.endsWith('/') && !url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

/** Validate and canonicalise a user-supplied upstream base URL. */
export function assertAllowedBaseUrl(rawUrl: string, policy: BaseUrlPolicy): URL {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new HttpError(400, 'invalid_base_url', 'Base URL is not a valid URL.');
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new HttpError(400, 'invalid_base_url', 'Base URL must use http or https.');
	}
	if (url.protocol === 'http:' && !policy.allowInsecureHttp) {
		throw new HttpError(
			400,
			'insecure_base_url',
			'Plain http is disabled because credentials would travel in the clear. Set ALLOW_INSECURE_HTTP=true to override.',
		);
	}
	if (url.username || url.password) {
		throw new HttpError(400, 'invalid_base_url', 'Credentials must not be embedded in the base URL.');
	}
	if (url.search || url.hash) {
		throw new HttpError(400, 'invalid_base_url', 'Base URL must not contain a query string or fragment.');
	}

	if (!policy.allowPrivateNetworks) {
		const reason = describeBlockedHost(url.hostname);
		if (reason) {
			throw new HttpError(
				400,
				'blocked_host',
				`Upstream host is not allowed (${reason}). Set ALLOW_PRIVATE_NETWORKS=true to reach servers on your local network.`,
			);
		}
	}

	// Ensure the pathname is directory-like so relative joins behave.
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

/** Returns a reason string when a hostname is private/reserved, else null. */
export function describeBlockedHost(hostname: string): string | null {
	let host = hostname.trim().toLowerCase().replace(/\.$/, '');
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
	if (!host) return 'empty host';

	if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback hostname';
	if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return 'private hostname suffix';
	if (host === 'metadata.google.internal') return 'cloud metadata service';

	if (host.includes(':')) return describeBlockedIpv6(host);

	const ipv4 = parseIpv4(host);
	if (ipv4) return describeBlockedIpv4(ipv4);

	return null;
}

function describeBlockedIpv4(octets: number[]): string | null {
	const [a, b, c] = octets;
	const is = (range: number[], prefixLength: number): boolean => {
		const bits = octets.map((o) => o.toString(2).padStart(8, '0')).join('');
		const prefix = range.map((o) => o.toString(2).padStart(8, '0')).join('').slice(0, prefixLength);
		return bits.slice(0, prefixLength) === prefix;
	};

	if (is([0], 8)) return 'this-network address';
	if (is([10], 8)) return 'private range 10/8';
	if (is([100, 64], 10)) return 'carrier-grade NAT range';
	if (is([127], 8)) return 'loopback address';
	if (is([169, 254], 16)) return 'link-local address (cloud metadata)';
	if (is([172, 16], 12)) return 'private range 172.16/12';
	if (is([192, 0, 0], 24)) return 'reserved range';
	if (is([192, 0, 2], 24)) return 'documentation range';
	if (is([192, 168], 16)) return 'private range 192.168/16';
	if (is([198, 18], 15)) return 'benchmark range';
	if (is([198, 51, 100], 24)) return 'documentation range';
	if (is([203, 0, 113], 24)) return 'documentation range';
	if (is([224], 4)) return 'multicast range';
	if (is([240], 4)) return 'reserved range';
	if (a === 255 && b === 255 && c === 255 && octets[3] === 255) return 'broadcast address';
	return null;
}

function describeBlockedIpv6(host: string): string | null {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
	if (mapped) {
		const ipv4 = parseIpv4(mapped[1]);
		if (ipv4) return describeBlockedIpv4(ipv4) ?? 'IPv4-mapped address';
	}

	const groups = expandIpv6(host);
	if (!groups) return null;

	// ::1 and ::
	if (groups.every((group) => group === 0) || (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1)) {
		return 'loopback or unspecified address';
	}
	// fc00::/7 unique local
	if ((groups[0] & 0xfe00) === 0xfc00) return 'unique-local address';
	// fe80::/10 link local
	if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local address';
	// ff00::/8 multicast
	if ((groups[0] & 0xff00) === 0xff00) return 'multicast address';
	return null;
}

function expandIpv6(host: string): number[] | null {
	const zone = host.indexOf('%');
	if (zone !== -1) host = host.slice(0, zone);
	if (!/^[0-9a-f:]+$/.test(host)) return null;

	const [headPart, tailPart] = host.split('::') as [string, string | undefined];
	const head = headPart ? headPart.split(':').filter(Boolean) : [];
	const tail = tailPart ? tailPart.split(':').filter(Boolean) : [];

	if (tailPart === undefined && head.length !== 8) return null;
	if (tailPart !== undefined && head.length + tail.length > 7) return null;

	const fill = new Array(8 - head.length - tail.length).fill('0');
	const all = [...head, ...fill, ...tail];
	if (all.length !== 8) return null;

	const groups: number[] = [];
	for (const group of all) {
		const value = Number.parseInt(group, 16);
		if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
		groups.push(value);
	}
	return groups;
}

/**
 * Parse an IPv4 literal, including the decimal / octal / hex shorthand forms
 * (`2130706433`, `0x7f.1`) that naive checks miss.
 */
function parseIpv4(host: string): number[] | null {
	const parts = host.split('.');
	if (parts.length === 0 || parts.length > 4) return null;

	const values: number[] = [];
	for (const part of parts) {
		const value = parseNumericPart(part);
		if (value === null) return null;
		values.push(value);
	}

	// inet_aton semantics: the final component absorbs all remaining bytes, so
	// 127.1, 127.0.1 and 2130706433 are all loopback.
	let combined = 0;
	for (let i = 0; i < values.length - 1; i++) {
		if (values[i] > 255) return null;
		combined = combined * 256 + values[i];
	}

	const remainingBytes = 4 - (values.length - 1);
	const maxLast = 2 ** (8 * remainingBytes) - 1;
	const last = values[values.length - 1];
	if (last > maxLast) return null;

	const address = combined * 2 ** (8 * remainingBytes) + last;
	if (address > 0xffffffff) return null;

	return [
		Math.floor(address / 2 ** 24) & 255,
		Math.floor(address / 2 ** 16) & 255,
		Math.floor(address / 2 ** 8) & 255,
		address & 255,
	];
}

function parseNumericPart(part: string): number | null {
	if (part === '') return null;
	if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part, 16);
	if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
	if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
	return null;
}
