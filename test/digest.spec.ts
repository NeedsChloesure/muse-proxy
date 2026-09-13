import { describe, expect, it } from 'vitest';

import { hashHex } from '../src/lib/crypto';
import {
	digestAuthorization,
	parseAuthChallenges,
	selectDigestChallenge,
	selectQuality,
	type DigestChallenge,
} from '../src/lib/digest';

/**
 * The published example from RFC 7616 section 3.9.1.
 *
 * This is what makes the implementation checkable by someone who does not want
 * to trust it: the expected response values come from the standard, not from a
 * run of this code. The RFC's server also sends *two* challenges — SHA-256
 * first, MD5 second — which is exactly the case that makes naive challenge
 * parsing and "just use MD5" both wrong.
 */
const RFC = {
	realm: 'http-auth@example.org',
	nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
	opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
	username: 'Mufasa',
	password: 'Circle of Life',
	uri: '/dir/index.html',
	method: 'GET',
	cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
	nc: 1,
	md5: '8ca523f5e9506fed4657c9700eebdbec',
	sha256: '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1',
};

const RFC_CREDENTIALS = { username: RFC.username, password: RFC.password };
const RFC_TARGET = { method: RFC.method, uri: RFC.uri };

function digestChallenge(algorithm?: string, extra = ''): string {
	const algorithmParam = algorithm ? `, algorithm=${algorithm}` : '';
	return `Digest realm="${RFC.realm}", qop="auth, auth-int"${algorithmParam}, nonce="${RFC.nonce}", opaque="${RFC.opaque}"${extra}`;
}

/** Headers carrying the same value more than once, as the RFC's server does. */
function headersWith(...values: string[]): Headers {
	const headers = new Headers();
	for (const value of values) headers.append('www-authenticate', value);
	return headers;
}

/** Read back an Authorization header the way a server would. */
function authParams(header: string): Record<string, string> {
	const params: Record<string, string> = {};
	const pattern = /([A-Za-z][A-Za-z0-9._+-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(header)) !== null) params[match[1]] = match[2] ?? match[3] ?? '';
	return params;
}

async function authorize(challenge: DigestChallenge): Promise<Record<string, string>> {
	const header = await digestAuthorization(challenge, RFC_CREDENTIALS, RFC_TARGET, {
		cnonce: RFC.cnonce,
		nc: RFC.nc,
	});
	return authParams(header);
}

describe('RFC 7616 known-answer vectors', () => {
	it('reproduces the MD5 response from RFC 7616 section 3.9.1', async () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge('MD5')));
		expect(challenge).not.toBeNull();

		const params = await authorize(challenge!);

		expect(params.response).toBe(RFC.md5);
		expect(params.nonce).toBe(RFC.nonce);
		expect(params.opaque).toBe(RFC.opaque);
	});

	it('reproduces the SHA-256 response from RFC 7616 section 3.9.1', async () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge('SHA-256')));

		const params = await authorize(challenge!);

		expect(params.response).toBe(RFC.sha256);
	});

	it('prefers the challenge the server listed first', () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge('SHA-256'), digestChallenge('MD5')));

		expect(challenge?.algorithm).toBe('SHA-256');
	});

	it('skips an algorithm it cannot compute and uses the next challenge', () => {
		const selection = selectDigestChallenge(headersWith(digestChallenge('SHA-512-256'), digestChallenge('MD5')));

		expect(selection.challenge?.algorithm).toBe('MD5');
		expect(selection.rejected.join(' ')).toContain('SHA-512-256');
	});

	it('refuses a challenge it cannot compute, naming the algorithm', () => {
		const selection = selectDigestChallenge(headersWith(digestChallenge('SHA-512-256')));

		expect(selection.challenge).toBeNull();
		expect(selection.rejected.join(' ')).toContain('unsupported algorithm');
	});

	it('refuses qop=auth-int rather than sending a response the server cannot verify', async () => {
		const selection = selectDigestChallenge(headersWith(digestChallenge('MD5').replace('"auth, auth-int"', '"auth-int"')));

		expect(selection.challenge).toBeNull();
		expect(selection.rejected.join(' ')).toContain('auth-int');

		// And it is refused at computation time too, not silently answered.
		await expect(authorize(qualityChallenge(['auth-int']))).rejects.toThrow(/auth-int/);
	});

	it('defaults to MD5 when the server omits algorithm', async () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge()));

		expect(challenge?.algorithm).toBe('MD5');
		// The default yields the same response as an explicit MD5 challenge.
		expect((await authorize(challenge!)).response).toBe(RFC.md5);
	});
});

describe('challenge parsing', () => {
	it('splits a trailing Basic challenge from the same header line', () => {
		const challenges = parseAuthChallenges(
			headersWith('Digest realm="auth@example.org", nonce="abc", qop="auth", Basic realm="admin"'),
		);

		expect(challenges.map((challenge) => challenge.scheme)).toEqual(['Digest', 'Basic']);
		expect(challenges[1].params.realm).toBe('admin');
	});

	it('keeps a comma that is inside a quoted parameter', () => {
		const challenges = parseAuthChallenges(headersWith(digestChallenge('MD5')));

		expect(challenges).toHaveLength(1);
		const digest = selectDigestChallenge(headersWith(digestChallenge('MD5'))).challenge;
		expect(digest?.qop).toEqual(['auth', 'auth-int']);
		expect(selectQuality(digest!)).toBe('auth');
	});

	it('unescapes a quoted value', () => {
		const challenges = parseAuthChallenges(headersWith('Digest realm="a \\"quoted\\" realm", nonce="n"'));

		expect(challenges[0].params.realm).toBe('a "quoted" realm');
	});

	it('reads a stale challenge, which means the credentials were fine', () => {
		const { challenge } = selectDigestChallenge(headersWith(`${digestChallenge('MD5')}, stale=true`));

		expect(challenge?.stale).toBe(true);
	});

	it('records userhash and charset rather than silently ignoring them', () => {
		const { challenge } = selectDigestChallenge(
			headersWith(`${digestChallenge('MD5')}, charset=UTF-8, userhash=true`),
		);

		expect(challenge?.userhash).toBe(true);
		expect(challenge?.charset).toBe('UTF-8');
	});

	it('ignores a bearer token without swallowing the next challenge', () => {
		const challenges = parseAuthChallenges(headersWith('Bearer abc123def, Basic realm="x"'));

		expect(challenges.map((challenge) => challenge.scheme)).toEqual(['Bearer', 'Basic']);
		expect(challenges[1].params.realm).toBe('x');
	});
});

describe('response construction', () => {
	it('sends the RFC 2069 form when no qop is advertised', async () => {
		const { challenge } = selectDigestChallenge(headersWith(`Digest realm="r", nonce="${RFC.nonce}"`));
		expect(selectQuality(challenge!)).toBe('legacy');

		const header = await digestAuthorization(challenge!, RFC_CREDENTIALS, RFC_TARGET, {
			cnonce: RFC.cnonce,
			nc: 1,
		});

		expect(header).not.toContain('qop=');
		expect(header).not.toContain('nc=');
		expect(header).toContain('algorithm=MD5');

		const ha1 = await hashHex('MD5', `${RFC.username}:r:${RFC.password}`);
		const ha2 = await hashHex('MD5', `${RFC.method}:${RFC.uri}`);
		expect(authParams(header).response).toBe(await hashHex('MD5', `${ha1}:${RFC.nonce}:${ha2}`));
	});

	it('applies the -sess variant to A1', async () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge('MD5-sess')));

		const header = await digestAuthorization(challenge!, RFC_CREDENTIALS, RFC_TARGET, {
			cnonce: RFC.cnonce,
			nc: 1,
		});

		const base = await hashHex('MD5', `${RFC.username}:${RFC.realm}:${RFC.password}`);
		const ha1 = await hashHex('MD5', `${base}:${RFC.nonce}:${RFC.cnonce}`);
		const ha2 = await hashHex('MD5', `${RFC.method}:${RFC.uri}`);
		expect(authParams(header).response).toBe(
			await hashHex('MD5', `${ha1}:${RFC.nonce}:00000001:${RFC.cnonce}:auth:${ha2}`),
		);
	});

	it('pads the nonce count to eight digits and does not quote it', async () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge('MD5')));

		const header = await digestAuthorization(challenge!, RFC_CREDENTIALS, RFC_TARGET, {
			cnonce: RFC.cnonce,
			nc: 0x1f,
		});

		expect(header).toContain('nc=0000001f');
		expect(authParams(header).nc).toBe('0000001f');
	});

	it('passes the request-target through with its percent-encoding intact', async () => {
		const { challenge } = selectDigestChallenge(headersWith(digestChallenge('MD5')));
		const uri = '/dav.php/calendars/alice/w%C3%B6rk/';

		const header = await digestAuthorization(challenge!, RFC_CREDENTIALS, { method: 'PROPFIND', uri }, {
			cnonce: RFC.cnonce,
			nc: 1,
		});

		expect(authParams(header).uri).toBe(uri);
	});
});

describe('runtime hashing', () => {
	it('provides MD5, which Digest needs and WebCrypto does not standardise', async () => {
		// A tripwire: if a runtime ever drops MD5, this fails in CI rather than as
		// an unexplained 401 against someone's calendar server.
		expect(await hashHex('MD5', 'abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(await hashHex('SHA-256', 'abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});
});

function qualityChallenge(qop: string[]): DigestChallenge {
	return {
		realm: 'r',
		nonce: 'n',
		algorithm: 'MD5',
		qop,
		opaque: null,
		stale: false,
		userhash: false,
		charset: null,
	};
}
