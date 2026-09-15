/**
 * HTTP Digest access authentication (RFC 7616, obsoleting RFC 2617).
 *
 * Why this exists: some upstreams refuse to accept a stored password as Basic.
 * Baikal's default is Digest (its SabreDAV backend is a Digest backend) and so
 * is a lot of DAV software generally. A server that only advertises Digest
 * cannot be satisfied with a Basic header no matter how correct the password
 * is, so the gateway has to answer the challenge instead of sending the secret.
 *
 * Two details shape the implementation:
 *
 *   - the digest covers the request-target of the request that is actually
 *     sent, which for this gateway is the UPSTREAM path, not the gateway path
 *     the agent addressed. Handing it the gateway path would produce a wrong
 *     response and, on a strict server, a 400;
 *   - a single response can carry several WWW-Authenticate challenges, and the
 *     server lists them in preference order (RFC 7616 §3.7). Selection walks
 *     that list and takes the first one we can actually compute, so a server
 *     offering SHA-512-256 *and* MD5 still works.
 *
 * Deliberately not implemented: `qop=auth-int` (hashes the entity body; no DAV
 * server advertises it, and there is no published vector to test against),
 * `userhash`, and SHA-512-256. Each is refused with a message naming it rather
 * than silently computing something the server will reject.
 */

import { hashHex } from './crypto';
import { HttpError } from './http';

export interface AuthChallenge {
	/** As spelled by the server, e.g. 'Digest'. */
	scheme: string;
	params: Record<string, string>;
}

export interface DigestChallenge {
	realm: string;
	nonce: string;
	/** As received; absent means MD5 (RFC 7616 §3.3). */
	algorithm: string;
	/** Offered qop values, lowercased. Empty means RFC 2069 (no qop). */
	qop: string[];
	opaque: string | null;
	/** The nonce was refused as stale, so the credentials themselves are fine. */
	stale: boolean;
	userhash: boolean;
	charset: string | null;
}

interface DigestAlgorithm {
	hash: 'MD5' | 'SHA-256';
	session: boolean;
}

const ALGORITHMS: Record<string, DigestAlgorithm> = {
	md5: { hash: 'MD5', session: false },
	'md5-sess': { hash: 'MD5', session: true },
	'sha-256': { hash: 'SHA-256', session: false },
	'sha-256-sess': { hash: 'SHA-256', session: true },
};

/** Quality of protection we will send, or null when we cannot produce one. */
export type DigestQuality = 'auth' | 'legacy';

export function digestAlgorithm(challenge: DigestChallenge): DigestAlgorithm | null {
	return ALGORITHMS[challenge.algorithm.toLowerCase()] ?? null;
}

/**
 * Which qop to send.
 *
 * 'auth' is what every server actually uses. An empty qop list means the server
 * predates RFC 2617 and wants the un-keyed RFC 2069 form. A server offering
 * only 'auth-int' is refused rather than answered wrongly.
 */
export function selectQuality(challenge: DigestChallenge): DigestQuality | null {
	if (challenge.qop.length === 0) return 'legacy';
	return challenge.qop.includes('auth') ? 'auth' : null;
}

export interface DigestSelection {
	challenge: DigestChallenge | null;
	/** Offered Digest challenges we could not answer, and why. */
	rejected: string[];
}

/**
 * Pick the Digest challenge to answer, or explain why none could be.
 *
 * Multiple WWW-Authenticate header *lines* are all considered: a server that
 * supports several algorithms must send one challenge per algorithm, each in
 * its own field (RFC 7616 §3.7), which is exactly what the RFC's own example
 * does.
 */
export function selectDigestChallenge(headers: Headers): DigestSelection {
	const rejected: string[] = [];
	let candidate: DigestChallenge | null = null;

	for (const challenge of parseAuthChallenges(headers)) {
		if (challenge.scheme.toLowerCase() !== 'digest') continue;

		const digest = toDigestChallenge(challenge.params);
		if (!digest) {
			rejected.push('Digest without a realm or nonce');
			continue;
		}
		if (candidate) continue;

		if (!digestAlgorithm(digest)) {
			rejected.push(`Digest (${digest.algorithm}): unsupported algorithm`);
			continue;
		}
		if (selectQuality(digest) === null) {
			rejected.push(`Digest (${digest.algorithm}): qop=${digest.qop.join('/')} is not supported`);
			continue;
		}
		if (digest.userhash) {
			rejected.push(`Digest (${digest.algorithm}): userhash is not supported`);
			continue;
		}
		candidate = digest;
	}

	return { challenge: candidate, rejected };
}

/** Every challenge offered by a response, in the order the server listed them. */
export function parseAuthChallenges(headers: Headers): AuthChallenge[] {
	const out: AuthChallenge[] = [];
	for (const value of headerValues(headers, 'www-authenticate')) {
		for (const chunk of splitChallenges(value)) {
			out.push({ scheme: chunk.scheme, params: parseParams(chunk.rest) });
		}
	}
	return out;
}

/** A response can carry the same header more than once; Headers.get hides that. */
function headerValues(headers: Headers, name: string): string[] {
	const out: string[] = [];
	for (const [key, value] of headers) {
		if (key.toLowerCase() === name) out.push(value);
	}
	return out;
}

export interface DigestCredentials {
	username: string;
	password: string;
}

export interface DigestRequestTarget {
	/** The method of the request being sent upstream. */
	method: string;
	/** Its request-target: the upstream path and query, percent-encoding intact. */
	uri: string;
}

export interface DigestState {
	cnonce: string;
	/** 1 for the first request against this nonce. */
	nc: number;
}

/**
 * Compute the Authorization header for one request.
 *
 * Callers must advance `nc` for each request made against the same nonce; a
 * server may treat a repeated nonce count as a replay.
 */
export async function digestAuthorization(
	challenge: DigestChallenge,
	credentials: DigestCredentials,
	target: DigestRequestTarget,
	state: DigestState,
): Promise<string> {
	const algorithm = digestAlgorithm(challenge);
	if (!algorithm) {
		throw new HttpError(500, 'unsupported_digest_algorithm', `The server asked for Digest with the ${challenge.algorithm} algorithm, which this gateway cannot compute.`);
	}
	const quality = selectQuality(challenge);
	if (quality === null) {
		throw new HttpError(500, 'unsupported_digest_qop', `The server asked for Digest with qop=${challenge.qop.join(',')}, which this gateway cannot compute.`);
	}
	// userhash=yes hashes the username into HA1 (RFC 7616 §3.4.2). Sending the
	// raw username would produce a response the server cannot verify, which is
	// the failure mode this refusal exists to avoid.
	if (challenge.userhash) {
		throw new HttpError(
			500,
			'unsupported_digest_userhash',
			'The server asked for Digest with userhash=yes, which this gateway cannot compute: the username is not hashed into HA1.',
		);
	}

	const h = (data: string) => hashHex(algorithm.hash, data);
	const nc = state.nc.toString(16).padStart(8, '0');

	// A1 (RFC 7616 §3.4.2)
	let ha1 = await h(`${credentials.username}:${challenge.realm}:${credentials.password}`);
	if (algorithm.session) ha1 = await h(`${ha1}:${challenge.nonce}:${state.cnonce}`);

	// A2 (§3.4.3). auth-int would append H(entity-body) here.
	const ha2 = await h(`${target.method}:${target.uri}`);

	// response (§3.4.1)
	const response =
		quality === 'auth'
			? await h(`${ha1}:${challenge.nonce}:${nc}:${state.cnonce}:auth:${ha2}`)
			: await h(`${ha1}:${challenge.nonce}:${ha2}`);

	const parts = [
		`username="${quoted(credentials.username)}"`,
		`realm="${quoted(challenge.realm)}"`,
		`nonce="${quoted(challenge.nonce)}"`,
		`uri="${quoted(target.uri)}"`,
		`response="${response}"`,
		// Historical: algorithm, qop and nc are sent unquoted.
		`algorithm=${challenge.algorithm}`,
	];

	if (quality === 'auth') parts.push('qop=auth', `nc=${nc}`, `cnonce="${quoted(state.cnonce)}"`);
	if (challenge.opaque !== null) parts.push(`opaque="${quoted(challenge.opaque)}"`);

	return `Digest ${parts.join(', ')}`;
}

// -- parsing -----------------------------------------------------------------

function toDigestChallenge(params: Record<string, string>): DigestChallenge | null {
	const realm = params.realm;
	const nonce = params.nonce;
	if (!realm || !nonce) return null;

	return {
		realm,
		nonce,
		algorithm: params.algorithm || 'MD5',
		qop: (params.qop ?? '')
			.split(',')
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean),
		opaque: params.opaque ?? null,
		stale: (params.stale ?? '').toLowerCase() === 'true',
		userhash: (params.userhash ?? '').toLowerCase() === 'true',
		charset: params.charset ?? null,
	};
}

/**
 * Split a WWW-Authenticate value into one chunk per challenge.
 *
 * A comma separates challenges from parameters, and quoted values contain both,
 * so the split cannot be a plain `split(',')`. The discriminator is what follows
 * the comma: `name=value` continues the current challenge, whereas a bare token
 * starts the next one.
 */
function splitChallenges(header: string): Array<{ scheme: string; rest: string }> {
	const chunks: Array<{ scheme: string; rest: string }> = [];
	let start = 0;
	let inQuotes = false;

	const push = (end: number) => {
		const match = /^\s*([A-Za-z][A-Za-z0-9._+-]*)([\s\S]*)$/.exec(header.slice(start, end));
		if (match) chunks.push({ scheme: match[1], rest: match[2] });
	};

	for (let i = 0; i < header.length; i += 1) {
		const char = header[i];
		if (char === '\\' && inQuotes) {
			i += 1;
			continue;
		}
		if (char === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (inQuotes || char !== ',') continue;
		if (startsChallenge(header, i)) {
			push(i);
			start = i + 1;
		}
	}

	push(header.length);
	return chunks;
}

function startsChallenge(header: string, commaIndex: number): boolean {
	const rest = header.slice(commaIndex + 1).replace(/^\s+/, '');
	const name = /^[A-Za-z][A-Za-z0-9._+-]*/.exec(rest);
	if (!name) return false;
	// `realm="x"` is a parameter; `Basic realm="x"` is a new challenge.
	return !rest.slice(name[0].length).replace(/^\s+/, '').startsWith('=');
}

function parseParams(rest: string): Record<string, string> {
	const params: Record<string, string> = {};
	const pattern = /([A-Za-z][A-Za-z0-9._+-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;

	let match: RegExpExecArray | null;
	while ((match = pattern.exec(rest)) !== null) {
		const raw = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] ?? '');
		params[match[1].toLowerCase()] = raw;
	}
	return params;
}

function quoted(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
