/**
 * Cryptography helpers.
 *
 * - Passwords: PBKDF2-HMAC-SHA256. The iteration count is stored inside the
 *   hash, so it can be raised later without invalidating existing accounts.
 * - Upstream credentials: AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY`.
 * - API keys and session tokens: 256 bits of CSPRNG output, looked up by
 *   SHA-256. They are high-entropy, so a slow KDF would buy nothing.
 */

import { HttpError } from './http';

const PBKDF2_HASH = 'SHA-256';
/** Label stored inside the hash. Deliberately not the WebCrypto identifier. */
const PBKDF2_LABEL = 'sha256';
const PBKDF2_BITS = 256;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;

const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	return base64ToBytes(padded);
}

/** Random URL-safe token. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return bytesToBase64Url(buf);
}

/**
 * Hex digest of a UTF-8 string.
 *
 * MD5 is deliberately included: WebCrypto omits it, but Cloudflare Workers
 * implements it anyway, and HTTP Digest needs it because MD5 is the default
 * (and still the most widely deployed) Digest algorithm. test/digest.spec.ts
 * asserts it works, so a runtime that drops it fails in CI rather than as a
 * mysterious 401 against someone's calendar.
 */
export async function hashHex(algorithm: 'MD5' | 'SHA-256', input: string): Promise<string> {
	const digest = await crypto.subtle.digest(algorithm, encoder.encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(input: string): Promise<string> {
	return hashHex('SHA-256', input);
}

/** Constant-time comparison. Length is allowed to leak (callers hash first). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

// -- passwords ---------------------------------------------------------------

export async function hashPassword(password: string, iterations: number): Promise<string> {
	const salt = new Uint8Array(SALT_BYTES);
	crypto.getRandomValues(salt);
	const derived = await derivePkbdf2(password, salt, iterations);
	return `pbkdf2$${PBKDF2_LABEL}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
	const iterations = Number.parseInt(parts[2], 10);
	if (!Number.isFinite(iterations) || iterations < 1) return false;

	let salt: Uint8Array;
	let expected: Uint8Array;
	try {
		salt = base64UrlToBytes(parts[3]);
		expected = base64UrlToBytes(parts[4]);
	} catch {
		return false;
	}

	const derived = await derivePkbdf2(password, salt, iterations);
	return timingSafeEqual(derived, expected);
}

async function derivePkbdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH }, key, PBKDF2_BITS);
	return new Uint8Array(bits);
}

// -- upstream credential encryption ------------------------------------------

function encryptionKeyBytes(env: { CREDENTIAL_ENCRYPTION_KEY?: string }): Uint8Array {
	const raw = env.CREDENTIAL_ENCRYPTION_KEY;
	if (!raw) {
		throw new HttpError(500, 'not_configured', 'CREDENTIAL_ENCRYPTION_KEY is not set; refusing to store credentials unencrypted.');
	}
	let bytes: Uint8Array;
	try {
		bytes = base64UrlToBytes(raw.trim());
	} catch {
		throw new HttpError(500, 'not_configured', 'CREDENTIAL_ENCRYPTION_KEY must be base64-encoded.');
	}
	if (bytes.length !== 32) {
		throw new HttpError(500, 'not_configured', `CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes (got ${bytes.length}).`);
	}
	return bytes;
}

async function importAesKey(env: { CREDENTIAL_ENCRYPTION_KEY?: string }): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', encryptionKeyBytes(env), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt a credential into `v1:<iv_b64url>:<ciphertext_b64url>`. */
export async function encryptSecret(plaintext: string, env: { CREDENTIAL_ENCRYPTION_KEY?: string }): Promise<string> {
	const key = await importAesKey(env);
	const iv = new Uint8Array(GCM_IV_BYTES);
	crypto.getRandomValues(iv);
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
	return `v1:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(blob: string, env: { CREDENTIAL_ENCRYPTION_KEY?: string }): Promise<string> {
	const [version, ivPart, cipherPart] = blob.split(':');
	if (version !== 'v1' || !ivPart || !cipherPart) {
		throw new HttpError(500, 'decrypt_failed', 'Unrecognised credential format.');
	}
	const key = await importAesKey(env);
	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: base64UrlToBytes(ivPart) },
			key,
			base64UrlToBytes(cipherPart),
		);
	} catch {
		// Either the blob is damaged or it was sealed under a different
		// CREDENTIAL_ENCRYPTION_KEY. Both must be reported as the local fault they
		// are: left to propagate, a provider's upstream-failure catch turns the
		// WebCrypto OperationError into a 502 blaming the calendar server.
		throw new HttpError(
			500,
			'decrypt_failed',
			'The stored credential could not be decrypted with this deployment’s CREDENTIAL_ENCRYPTION_KEY.',
		);
	}
	return new TextDecoder().decode(plaintext);
}

/** Non-reversible hint for the UI, so users can tell credentials apart. */
export function secretHint(secret: string): string {
	if (secret.length <= 4) return '••••';
	return '••••' + secret.slice(-4);
}
