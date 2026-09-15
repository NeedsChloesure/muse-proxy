/**
 * The admin API: everything a human does.
 *
 * Session-cookie authenticated, same-origin only, and disjoint from the agent
 * API (a session cannot act as a key, and a key cannot act as a session).
 */

import { Hono } from 'hono';

import { configFrom } from '../config';
import { requireAdmin, requireSameOrigin, requireSession, signupAllowed, type AppBindings, type AppContext } from '../auth/middleware';
import * as repo from '../db/repo';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { HttpError, json } from '../lib/http';
import { clearSessionCookieHeader, sessionCookieHeader } from '../lib/session';
import { optionalString, readJson, requiredString, USERNAME_PATTERN } from '../lib/validate';
import { API_VERSION, type Account } from '../types';
import { allProviders } from '../providers/registry';
import { connectionRoutes } from './connections';
import { keyRoutes } from './keys';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export const adminRoutes = new Hono<AppBindings>();

// Error handling and the JSON 404 live on the parent router in src/index.ts,
// which knows the full /api/admin prefix.

// -- auth --------------------------------------------------------------------

const auth = new Hono<AppBindings>();

auth.post('/signup', requireSameOrigin, async (c) => {
	const body = await readJson(c.req.raw);
	const username = requiredString(body, 'username', {
		pattern: USERNAME_PATTERN,
		max: 64,
		hint: 'The username may contain letters, digits and . _ @ -',
	});
	const password = requiredString(body, 'password', { min: 10, max: 200, trim: false });

	const accountCount = await repo.countAccounts(c.env.DB);
	if (!signupAllowed(c.env, accountCount)) {
		throw new HttpError(403, 'signup_disabled', 'Account creation is disabled on this deployment.');
	}
	if (await repo.getAccountByUsername(c.env.DB, username)) {
		throw new HttpError(409, 'username_taken', 'That username is already taken.');
	}

	const config = configFrom(c.env);
	const id = crypto.randomUUID();
	const passwordHash = await hashPassword(password, config.pbkdf2Iterations);
	let isAdmin = false;
	try {
		if (accountCount === 0) {
			// Claiming the bootstrap role is one atomic INSERT. A second signup that
			// observed the same empty database must not become an administrator too.
			isAdmin = await repo.createFirstAccount(c.env.DB, {
				id,
				username,
				passwordHash,
				createdAt: Date.now(),
			});
		}
		if (!isAdmin) {
			// The first-account check can lose a race after the initial count. Re-read
			// the state before allowing a concurrent request through signup gating.
			const currentCount = await repo.countAccounts(c.env.DB);
			if (!signupAllowed(c.env, currentCount)) {
				throw new HttpError(403, 'signup_disabled', 'Account creation is disabled on this deployment.');
			}
			await repo.createAccount(c.env.DB, {
				id,
				username,
				passwordHash,
				isAdmin: false,
				createdAt: Date.now(),
			});
		}
	} catch (error) {
		if (error instanceof HttpError) throw error;
		// Unique index race between the check above and the insert.
		throw new HttpError(409, 'username_taken', 'That username is already taken.');
	}

	const cookie = await issueSession(c.env, id, c.req.header('user-agent') ?? null);
	const account = (await repo.getAccountById(c.env.DB, id))!;
	return json({ ok: true, apiVersion: API_VERSION, data: { account: accountView(account) } }, { headers: { 'set-cookie': cookie } });
});

auth.post('/login', requireSameOrigin, async (c) => {
	const body = await readJson(c.req.raw);
	const username = requiredString(body, 'username', { min: 1, max: 64 });
	const password = requiredString(body, 'password', { min: 1, max: 200, trim: false });
	const config = configFrom(c.env);
	const now = Date.now();

	const account = await repo.getAccountByUsername(c.env.DB, username);

	if (!account) {
		// Do the same work as a real verification so response time does not
		// reveal whether the username exists.
		await hashPassword(password, config.pbkdf2Iterations);
		throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
	}

	if (account.disabledAt !== null) {
		// Preserve roughly the same work as a real verification without
		// incrementing a disabled account's brute-force counters.
		await hashPassword(password, config.pbkdf2Iterations);
		throw new HttpError(403, 'account_disabled', 'This account is disabled.');
	}

	if (account.lockedUntil !== null && account.lockedUntil > now) {
		const seconds = Math.ceil((account.lockedUntil - now) / 1000);
		throw new HttpError(429, 'account_locked', `Too many failed attempts. Try again in ${seconds}s.`);
	}

	if (!(await verifyPassword(password, account.passwordHash))) {
		await repo.registerFailedLogin(c.env.DB, account, now, MAX_FAILED_LOGINS, LOCKOUT_MS);
		throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
	}

	await repo.clearFailedLogins(c.env.DB, account.id);
	const cookie = await issueSession(c.env, account.id, c.req.header('user-agent') ?? null);
	c.executionCtx.waitUntil(repo.purgeExpiredSessions(c.env.DB, now));

	return json({ ok: true, apiVersion: API_VERSION, data: { account: accountView(account) } }, { headers: { 'set-cookie': cookie } });
});

auth.post('/logout', requireSession, requireSameOrigin, async (c) => {
	await repo.deleteSessionByTokenHash(c.env.DB, c.get('session').session.tokenHash);
	return json({ ok: true, data: { signedOut: true } }, { headers: { 'set-cookie': clearSessionCookieHeader() } });
});

auth.get('/me', requireSession, (c) => {
	const account = c.get('session').account;
	const config = configFrom(c.env);
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: { account: accountView(account), signupEnabled: config.signupEnabled },
	});
});

auth.post('/password', requireSession, requireSameOrigin, async (c) => {
	const body = await readJson(c.req.raw);
	const current = requiredString(body, 'currentPassword', { min: 1, max: 200, trim: false });
	const next = requiredString(body, 'newPassword', { min: 10, max: 200, trim: false });
	const account = c.get('session').account;

	if (!(await verifyPassword(current, account.passwordHash))) {
		throw new HttpError(401, 'invalid_credentials', 'The current password is incorrect.');
	}

	const config = configFrom(c.env);
	await repo.setAccountPassword(c.env.DB, account.id, await hashPassword(next, config.pbkdf2Iterations));
	// Changing a password signs every other session out.
	await repo.deleteAccountSessions(c.env.DB, account.id);
	const cookie = await issueSession(c.env, account.id, c.req.header('user-agent') ?? null);

	return json({ ok: true, data: { updated: true } }, { headers: { 'set-cookie': cookie } });
});

adminRoutes.route('/auth', auth);

// -- public metadata ---------------------------------------------------------

adminRoutes.get('/meta', async (c) => {
	const accountCount = await repo.countAccounts(c.env.DB);
	return json({
		ok: true,
		apiVersion: API_VERSION,
		data: {
			// True when the deployment is still unclaimable-free (no accounts yet).
			signupEnabled: signupAllowed(c.env, accountCount),
			hasAccounts: accountCount > 0,
			apiVersion: API_VERSION,
			// The console renders a connection form straight from these declarations,
			// so a new provider appears in the UI without frontend changes.
			providers: allProviders().map((provider) => ({
				type: provider.type,
				displayName: provider.displayName,
				summary: provider.summary,
				defaultAuthType: provider.defaultAuthType,
				docsUrl: provider.docsPath,
				fields: provider.fields,
				credentials: provider.credentials,
			})),
		},
	});
});

// -- mounted sections --------------------------------------------------------

adminRoutes.route('/connections', connectionRoutes);
adminRoutes.route('/keys', keyRoutes);

const accounts = new Hono<AppBindings>();
accounts.use('*', requireSession, requireSameOrigin, requireAdmin);

accounts.get('/', async (c) => {
	const all = await repo.listAccounts(c.env.DB);
	// `connectionCount` counts connections. It used to be filled from each
	// account's API keys, so an account with three keys and no connections
	// reported three connections.
	const connections = await Promise.all(all.map((account) => repo.listConnections(c.env.DB, account.id)));
	return json({
		ok: true,
		data: {
			accounts: all.map((account, index) => ({
				...accountView(account),
				connectionCount: (connections[index] ?? []).length,
			})),
		},
	});
});

accounts.post('/', async (c) => {
	const body = await readJson(c.req.raw);
	const username = requiredString(body, 'username', { pattern: USERNAME_PATTERN, max: 64 });
	const password = requiredString(body, 'password', { min: 10, max: 200, trim: false });
	const isAdmin = body.isAdmin === true;

	if (await repo.getAccountByUsername(c.env.DB, username)) {
		throw new HttpError(409, 'username_taken', 'That username is already taken.');
	}

	const config = configFrom(c.env);
	const id = crypto.randomUUID();
	await repo.createAccount(c.env.DB, {
		id,
		username,
		passwordHash: await hashPassword(password, config.pbkdf2Iterations),
		isAdmin,
		createdAt: Date.now(),
	});

	const account = (await repo.getAccountById(c.env.DB, id))!;
	return json({ ok: true, data: { account: accountView(account) } });
});

accounts.patch('/:id', async (c) => {
	const body = await readJson(c.req.raw);
	const target = await repo.getAccountById(c.env.DB, c.req.param('id'));
	if (!target) throw new HttpError(404, 'not_found', 'No such account.');

	const self = c.get('session').account;
	if (target.id === self.id && (body.disabled === true || body.isAdmin === false)) {
		throw new HttpError(400, 'invalid_request', 'You cannot disable or demote your own account.');
	}

	if (typeof body.isAdmin === 'boolean') await repo.updateAccountFlags(c.env.DB, target.id, { isAdmin: body.isAdmin });
	if (typeof body.disabled === 'boolean') {
		await repo.updateAccountFlags(c.env.DB, target.id, { disabledAt: body.disabled ? Date.now() : null });
		if (body.disabled) await repo.deleteAccountSessions(c.env.DB, target.id);
	}

	const refreshed = (await repo.getAccountById(c.env.DB, target.id))!;
	return json({ ok: true, data: { account: accountView(refreshed) } });
});

adminRoutes.route('/accounts', accounts);

// -- helpers -----------------------------------------------------------------

async function issueSession(env: Env, accountId: string, userAgent: string | null): Promise<string> {
	const config = configFrom(env);
	const token = randomToken(32);
	const now = Date.now();
	const maxAge = config.sessionTtlDays * 86_400;

	await repo.createSession(env.DB, {
		id: crypto.randomUUID(),
		tokenHash: await sha256Hex(token),
		accountId,
		createdAt: now,
		expiresAt: now + maxAge * 1000,
		userAgent,
	});

	return sessionCookieHeader(token, maxAge);
}

function accountView(account: Account) {
	return {
		id: account.id,
		username: account.username,
		isAdmin: account.isAdmin,
		createdAt: account.createdAt,
		disabledAt: account.disabledAt,
	};
}

export { optionalString, requiredString, type AppContext };
