/**
 * Minimal request-body validation. Every failure is a 400 with a field name,
 * so the SPA can point at the offending input.
 */

import { HttpError } from './http';

export function asObject(value: unknown, what = 'body'): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, 'invalid_request', `Expected ${what} to be a JSON object.`);
	}
	return value as Record<string, unknown>;
}

interface StringOptions {
	min?: number;
	max?: number;
	trim?: boolean;
	pattern?: RegExp;
	hint?: string;
}

export function requiredString(obj: Record<string, unknown>, field: string, options: StringOptions = {}): string {
	const raw = obj[field];
	if (typeof raw !== 'string') {
		throw new HttpError(400, 'invalid_request', `'${field}' is required and must be a string.`);
	}
	return checkString(raw, field, options);
}

export function optionalString(
	obj: Record<string, unknown>,
	field: string,
	options: StringOptions = {},
): string | undefined {
	const raw = obj[field];
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw !== 'string') {
		throw new HttpError(400, 'invalid_request', `'${field}' must be a string.`);
	}
	return checkString(raw, field, options);
}

function checkString(raw: string, field: string, options: StringOptions): string {
	const value = options.trim === false ? raw : raw.trim();
	const min = options.min ?? 1;
	if (value.length < min) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be at least ${min} characters.`);
	}
	if (options.max !== undefined && value.length > options.max) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be at most ${options.max} characters.`);
	}
	if (options.pattern && !options.pattern.test(value)) {
		throw new HttpError(400, 'invalid_request', options.hint ?? `'${field}' has an invalid format.`);
	}
	return value;
}

export function requiredOneOf<T extends string>(
	obj: Record<string, unknown>,
	field: string,
	allowed: readonly T[],
): T {
	const raw = obj[field];
	if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be one of: ${allowed.join(', ')}.`);
	}
	return raw as T;
}

export function optionalOneOf<T extends string>(
	obj: Record<string, unknown>,
	field: string,
	allowed: readonly T[],
): T | undefined {
	if (obj[field] === undefined || obj[field] === null) return undefined;
	return requiredOneOf(obj, field, allowed);
}

export function optionalInt(
	obj: Record<string, unknown>,
	field: string,
	options: { min?: number; max?: number } = {},
): number | undefined {
	const raw = obj[field];
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'number' || !Number.isInteger(raw)) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be an integer.`);
	}
	if (options.min !== undefined && raw < options.min) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be >= ${options.min}.`);
	}
	if (options.max !== undefined && raw > options.max) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be <= ${options.max}.`);
	}
	return raw;
}

export function requiredArray(obj: Record<string, unknown>, field: string, max = 500): unknown[] {
	const raw = obj[field];
	if (!Array.isArray(raw)) {
		throw new HttpError(400, 'invalid_request', `'${field}' must be an array.`);
	}
	if (raw.length > max) {
		throw new HttpError(400, 'invalid_request', `'${field}' may contain at most ${max} entries.`);
	}
	return raw;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		throw new HttpError(400, 'invalid_request', 'Request body must be valid JSON.');
	}
	return asObject(parsed);
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{3,64}$/;
