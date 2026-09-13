/**
 * Authentication middleware.
 *
 * Two disjoint credential types, deliberately never interchangeable:
 *   - `/api/admin/*` accepts ONLY a session cookie (a human in a browser);
 *   - `/api/agent/*` accepts ONLY a Bearer API key (a program).
 * Neither falls back to the other, so a leaked session cannot be used as an
 * agent key and a leaked key cannot administer the account.
 */

import type { Context, MiddlewareHandler } from 'hono';

import { configFrom } from '../config';
import { getAccountById, getApiKeyByTokenHash, getSessionByTokenHash } from '../db/repo';
import { HttpError, json, problem } from '../lib/http';
import { parseCookies, SESSION_COOKIE } from '../lib/session';
import { sha256Hex } from '../lib/crypto';
import type { AgentIdentity, ApiKey, SessionIdentity } from '../types';

export interface AppBindings {
	Bindings: Env;
	Variables: {
		session: SessionIdentity;
		agent: AgentIdentity;
	};
}

export type AppContext = Context<AppBindings>;

function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

export function isKeyUsable(key: ApiKey, now: number): boolean {
	// Revocation deletes the row outright, so expiry is the only way a stored
	// key stops being usable.
	return key.expiresAt === null || key.expiresAt > now;
}

export const requireSession: MiddlewareHandler<AppBindings> = async (c, next) => {
	const token = parseCookies(c.req.header('cookie') ?? null)[SESSION_COOKIE];
	if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');

	const session = await getSessionByTokenHash(c.env.DB, await sha256Hex(token));
	if (!session) throw new HttpError(401, 'unauthenticated', 'Session is no longer valid.');

	const now = Date.now();
	if (session.expiresAt <= now) throw new HttpError(401, 'unauthenticated', 'Session has expired.');

	const account = await getAccountById(c.env.DB, session.accountId);
	if (!account) throw new HttpError(401, 'unauthenticated', 'Account no longer exists.');
	if (account.disabledAt !== null) throw new HttpError(403, 'account_disabled', 'This account is disabled.');

	c.set('session', { account, session });
	await next();
};

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
	const identity = c.get('session');
	if (!identity) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
	if (!identity.account.isAdmin) throw new HttpError(403, 'forbidden', 'Administrator access is required.');
	await next();
};

/**
 * Resolve a Bearer key. Used wherever an agent request needs identity but the
 * provider handles the request itself (the catalog, the notices endpoints).
 */
export async function resolveAgentIdentity(env: Env, request: Request): Promise<AgentIdentity> {
	const token = bearerToken(request);
	if (!token) {
		throw new HttpError(401, 'unauthenticated', 'Provide an API key as `Authorization: Bearer muse_...`.');
	}

	const key = await getApiKeyByTokenHash(env.DB, await sha256Hex(token));
	// One generic error: distinguishing "no such key" from "expired key" would
	// help an attacker enumerate tokens.
	if (!key || !isKeyUsable(key, Date.now())) {
		throw new HttpError(401, 'invalid_key', 'That API key is not valid.');
	}

	const account = await getAccountById(env.DB, key.accountId);
	if (!account || account.disabledAt !== null) {
		throw new HttpError(403, 'account_disabled', 'The account owning this key is disabled.');
	}

	return { key, account };
}

export const requireAgentKey: MiddlewareHandler<AppBindings> = async (c, next) => {
	c.set('agent', await resolveAgentIdentity(c.env, c.req.raw));
	await next();
};

/**
 * CSRF defence in depth. The session cookie is SameSite=Lax, which already
 * blocks cross-site POSTs; this also rejects a mismatched Origin outright.
 * A missing Origin means a non-browser client, which cannot be a CSRF vector
 * because it would have to send the cookie anyway.
 */
export const requireSameOrigin: MiddlewareHandler<AppBindings> = async (c, next) => {
	const method = c.req.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

	const origin = c.req.header('origin');
	if (origin) {
		const expected = new URL(c.req.url).origin;
		if (origin !== expected) {
			throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
		}
	}
	const fetchSite = c.req.header('sec-fetch-site');
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed.');
	}
	await next();
};

export function signupAllowed(env: Env, accountCount: number): boolean {
	// The very first account can always be created, otherwise a deployment with
	// signup disabled could never be bootstrapped.
	if (accountCount === 0) return true;
	return configFrom(env).signupEnabled;
}

export { json, problem };
