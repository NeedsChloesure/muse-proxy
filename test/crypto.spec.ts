import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
	base64UrlToBytes,
	bytesToBase64Url,
	decryptSecret,
	encryptSecret,
	hashPassword,
	randomToken,
	secretHint,
	sha256Hex,
	verifyPassword,
} from '../src/lib/crypto';

const ITERATIONS = 1000;

describe('password hashing', () => {
	it('round-trips and records the iteration count', async () => {
		const hash = await hashPassword('correct horse battery staple', ITERATIONS);
		expect(hash.startsWith(`pbkdf2$sha256$${ITERATIONS}$`)).toBe(true);
		await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
	});

	it('rejects the wrong password', async () => {
		const hash = await hashPassword('right', ITERATIONS);
		await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
		await expect(verifyPassword('', hash)).resolves.toBe(false);
	});

	it('salts each hash, so identical passwords differ', async () => {
		const a = await hashPassword('same', ITERATIONS);
		const b = await hashPassword('same', ITERATIONS);
		expect(a).not.toBe(b);
		await expect(verifyPassword('same', a)).resolves.toBe(true);
		await expect(verifyPassword('same', b)).resolves.toBe(true);
	});

	it('detects tampering with the stored digest', async () => {
		const hash = await hashPassword('secret', ITERATIONS);
		const parts = hash.split('$');
		parts[4] = parts[4].slice(0, -2) + (parts[4].endsWith('AA') ? 'BB' : 'AA');
		await expect(verifyPassword('secret', parts.join('$'))).resolves.toBe(false);
	});

	it('returns false for malformed input rather than throwing', async () => {
		await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
		await expect(verifyPassword('x', 'pbkdf2$sha256$abc$AA$BB')).resolves.toBe(false);
		await expect(verifyPassword('x', 'pbkdf2$sha256$1000$!!!$!!!')).resolves.toBe(false);
		await expect(verifyPassword('x', '')).resolves.toBe(false);
	});

	it('accepts a higher iteration count without changing the format', async () => {
		const hash = await hashPassword('portable', 4000);
		expect(hash.startsWith('pbkdf2$sha256$4000$')).toBe(true);
		await expect(verifyPassword('portable', hash)).resolves.toBe(true);
	});
});

describe('credential encryption', () => {
	it('round-trips through AES-GCM', async () => {
		const blob = await encryptSecret('upstream-password', env);
		expect(blob.startsWith('v1:')).toBe(true);
		await expect(decryptSecret(blob, env)).resolves.toBe('upstream-password');
	});

	it('never produces the same ciphertext twice', async () => {
		const a = await encryptSecret('same', env);
		const b = await encryptSecret('same', env);
		expect(a).not.toBe(b);
		await expect(decryptSecret(a, env)).resolves.toBe('same');
		await expect(decryptSecret(b, env)).resolves.toBe('same');
	});

	it('does not contain the plaintext', async () => {
		const blob = await encryptSecret('super-secret-value', env);
		expect(blob).not.toContain('super-secret-value');
	});

	it('fails to decrypt under a different key, as a labelled 500', async () => {
		const blob = await encryptSecret('secret', env);
		const other = { CREDENTIAL_ENCRYPTION_KEY: bytesToBase64Url(new Uint8Array(32).fill(7)) };

		// Not just "it throws": an unlabelled WebCrypto error used to be caught by
		// the provider's upstream-failure handler and reported to the user as a 502
		// blaming their calendar server for a local key mismatch.
		await expect(decryptSecret(blob, other)).rejects.toMatchObject({
			status: 500,
			code: 'decrypt_failed',
		});
	});

	it('reports a damaged ciphertext as the same local fault', async () => {
		const blob = await encryptSecret('secret', env);
		const [version, iv, cipher] = blob.split(':');
		const damaged = `${version}:${iv}:${cipher.slice(0, -4)}AAAA`;
		await expect(decryptSecret(damaged, env)).rejects.toMatchObject({ status: 500, code: 'decrypt_failed' });
	});

	it('refuses to operate without a configured key', async () => {
		await expect(encryptSecret('x', {})).rejects.toThrowError(/CREDENTIAL_ENCRYPTION_KEY is not set/);
	});

	it('refuses a key that is not 32 bytes', async () => {
		await expect(encryptSecret('x', { CREDENTIAL_ENCRYPTION_KEY: bytesToBase64Url(new Uint8Array(16)) })).rejects.toThrowError(
			/32 bytes/,
		);
	});

	it('handles unicode credentials', async () => {
		const blob = await encryptSecret('pässwörd–✓', env);
		await expect(decryptSecret(blob, env)).resolves.toBe('pässwörd–✓');
	});
});

describe('tokens and digests', () => {
	it('produces 256-bit url-safe tokens', () => {
		const token = randomToken(32);
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(base64UrlToBytes(token).length).toBe(32);
	});

	it('does not repeat tokens', () => {
		const tokens = new Set(Array.from({ length: 200 }, () => randomToken(32)));
		expect(tokens.size).toBe(200);
	});

	it('hashes deterministically', async () => {
		expect(await sha256Hex('muse_abc')).toBe(await sha256Hex('muse_abc'));
		expect(await sha256Hex('muse_abc')).not.toBe(await sha256Hex('muse_abd'));
		expect(await sha256Hex('muse_abc')).toMatch(/^[0-9a-f]{64}$/);
	});

	it('round-trips base64url', () => {
		const bytes = new Uint8Array([0, 1, 250, 255, 128, 64]);
		expect([...base64UrlToBytes(bytesToBase64Url(bytes))]).toEqual([...bytes]);
	});
});

describe('secretHint', () => {
	it('reveals only the tail', () => {
		expect(secretHint('my-super-password')).toBe('••••word');
		expect(secretHint('ab')).toBe('••••');
	});
});
