/**
 * Small, dependency-free helpers shared by the mail data layer, the console
 * routes and the agent provider.
 *
 * Deliberately separate from src/lib: those helpers are about accounts,
 * sessions and upstream credentials, while these are about MIME parts, byte
 * budgets and cursor pagination.
 */

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Short, prefixed, URL-safe identifier. Not cryptographic; tokens use randomToken(). */
export function newId(prefix: string, bytes = 12): string {
	const buffer = crypto.getRandomValues(new Uint8Array(bytes));
	let out = '';
	for (const byte of buffer) out += ID_ALPHABET[byte & 31];
	return `${prefix}_${out}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** SHA-256 over text or raw bytes, hex-encoded. */
export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
	const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	const bytes = new Uint8Array(digest);
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

const ADDRESS_RE =
	/^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeAddress(value: string): string {
	return value.trim().toLowerCase().replace(/^</, '').replace(/>$/, '');
}

export function isValidAddress(value: string): boolean {
	return value.length <= 254 && ADDRESS_RE.test(value);
}

export function splitAddress(value: string): { localPart: string; domain: string } {
	const at = value.lastIndexOf('@');
	return { localPart: value.slice(0, at), domain: value.slice(at + 1) };
}

/** Escape user input used inside a SQL LIKE pattern. Pair with `ESCAPE '\'`. */
export function escapeLike(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface Cursor {
	receivedAt: string;
	id: string;
}

export function encodeCursor(cursor: Cursor): string {
	const json = JSON.stringify({ r: cursor.receivedAt, i: cursor.id });
	return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(value: string): Cursor | null {
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/');
		const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (typeof record.r !== 'string' || typeof record.i !== 'string') return null;
		return { receivedAt: record.r, id: record.i };
	} catch {
		return null;
	}
}

export interface TruncatedText {
	text: string;
	bytes: number;
	truncated: boolean;
}

const encoder = new TextEncoder();

/** Truncate text to a UTF-8 byte budget without splitting a code point badly. */
export function toText(value: string | null | undefined, maxBytes: number): TruncatedText {
	const input = value ?? '';
	if (!input) return { text: '', bytes: 0, truncated: false };
	const full = encoder.encode(input);
	if (full.length <= maxBytes) return { text: input, bytes: full.length, truncated: false };
	let text = input.slice(0, Math.max(0, maxBytes));
	while (text.length > 0 && encoder.encode(text).length > maxBytes) {
		text = text.slice(0, Math.floor(text.length * 0.95));
	}
	return { text, bytes: encoder.encode(text).length, truncated: true };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = value >= 10 || unit === 0 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[unit]}`;
}

export function safeFilename(value: string | null | undefined): string {
	const cleaned = (value ?? '')
		.replace(/[/\\]/g, '_')
		.replace(/[\u0000-\u001f\u007f"]/g, '')
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 180) : 'attachment';
}

export function contentDisposition(filename: string | null, disposition: 'attachment' | 'inline' = 'attachment'): string {
	const name = safeFilename(filename);
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Normalize D1's BLOB representation (ArrayBuffer, typed array, or number array). */
export function toArrayBuffer(value: unknown): ArrayBuffer {
	if (value instanceof ArrayBuffer) return value;
	if (ArrayBuffer.isView(value)) {
		const copy = new Uint8Array(value.byteLength);
		copy.set(new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
		return copy.buffer;
	}
	if (Array.isArray(value)) return new Uint8Array(value as number[]).buffer;
	if (typeof value === 'string' && value.length > 0) {
		return new TextEncoder().encode(value).buffer as ArrayBuffer;
	}
	return new ArrayBuffer(0);
}

export function parseStringArray(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === 'string');
	} catch {
		return [];
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
