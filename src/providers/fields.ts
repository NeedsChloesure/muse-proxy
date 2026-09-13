/**
 * Declarative config validation.
 *
 * A provider declares its fields once; this validates an incoming config
 * against them. Two properties matter:
 *
 *   - the result contains only declared fields, so a connection's config is a
 *     closed set and cannot smuggle arbitrary keys into storage;
 *   - required/type/options checks live here rather than being re-written per
 *     provider, which is where a missing check would otherwise become a bug.
 *
 * Semantic validation (does the URL violate the SSRF policy?) stays with the
 * provider, in verifyConfig.
 */

import { HttpError } from '../lib/http';
import type { ProviderField } from './types';

/**
 * Parse a stored provider config blob.
 *
 * Defensive by design: a config written by an older version of a provider must
 * degrade to "missing field" (a clear 400) rather than throwing an unhandled
 * error during a permission decision.
 */
export function parseConfig(configJson: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(configJson);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function validateFields(fields: readonly ProviderField[], input: unknown): Record<string, unknown> {
	// undefined/null means "no config supplied", which the required checks below
	// report field by field. Anything else that is not an object is a client
	// error worth naming.
	const source = input === undefined || input === null ? {} : input;
	if (typeof source !== 'object' || Array.isArray(source)) {
		throw new HttpError(400, 'invalid_request', "'config' must be an object.");
	}

	const out: Record<string, unknown> = {};

	for (const field of fields) {
		const raw = (source as Record<string, unknown>)[field.name];

		if (raw === undefined || raw === null || raw === '') {
			if (field.required) {
				throw new HttpError(400, 'invalid_request', `'${field.name}' is required.`, { field: field.name });
			}
			if (field.default !== undefined) out[field.name] = field.default;
			continue;
		}

		if (typeof raw !== 'string' && typeof raw !== 'number') {
			throw new HttpError(400, 'invalid_request', `'${field.name}' must be a string.`, { field: field.name });
		}

		const value = String(raw).trim();

		if (field.type === 'number') {
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed)) {
				throw new HttpError(400, 'invalid_request', `'${field.name}' must be a number.`, { field: field.name });
			}
			out[field.name] = parsed;
			continue;
		}

		if (field.type === 'select' && field.options && !field.options.includes(value)) {
			throw new HttpError(400, 'invalid_request', `'${field.name}' must be one of: ${field.options.join(', ')}.`, {
				field: field.name,
			});
		}

		if (field.type === 'url') {
			try {
				new URL(value);
			} catch {
				throw new HttpError(400, 'invalid_request', `'${field.name}' must be a URL.`, { field: field.name });
			}
		}

		out[field.name] = value;
	}

	return out;
}
