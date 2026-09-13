/**
 * Session cookie plumbing.
 *
 * The cookie carries a 256-bit random token; only its SHA-256 is stored, so a
 * database leak does not hand over live sessions.
 */

export const SESSION_COOKIE = 'muse_session';

export function parseCookies(header: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index === -1) continue;
		const name = part.slice(0, index).trim();
		if (!name) continue;
		const raw = part.slice(index + 1).trim();
		// This parses an untrusted header. A malformed escape (`%`, `%zz`) makes
		// decodeURIComponent throw, and a URIError escaping from a cookie is a 500
		// for what is really just an unusable cookie, so fall back to the raw
		// value and let the lookup fail the request with a 401.
		try {
			out[name] = decodeURIComponent(raw);
		} catch {
			out[name] = raw;
		}
	}
	return out;
}

/**
 * SameSite=Lax rather than Strict: the SPA is same-origin, and Lax keeps the
 * cookie usable after a normal top-level navigation without opening up
 * cross-site POSTs (which are additionally blocked by the origin check).
 */
export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
	return [
		`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
		'HttpOnly',
		'Secure',
		'SameSite=Lax',
		'Path=/',
		`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
	].join('; ');
}

export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
