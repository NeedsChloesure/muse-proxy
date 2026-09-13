import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { signupAllowed } from '../src/auth/middleware';
import * as repo from '../src/db/repo';
import { encryptSecret } from '../src/lib/crypto';
import { API_VERSION } from '../src/types';
import { adminOk, cookieFrom, signUp, url } from './helpers';

const fakeEnv = (signupEnabled: string) => ({ SIGNUP_ENABLED: signupEnabled }) as unknown as Env;

async function login(username: string, password: string): Promise<Response> {
	return SELF.fetch(url('/api/admin/auth/login'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
}

describe('signup gating', () => {
	it('always permits the first account, even with signup switched off', () => {
		// Otherwise a locked-down deployment could never be bootstrapped.
		expect(signupAllowed(fakeEnv('false'), 0)).toBe(true);
	});

	it('honours SIGNUP_ENABLED once an account exists', () => {
		expect(signupAllowed(fakeEnv('false'), 1)).toBe(false);
		expect(signupAllowed(fakeEnv('true'), 1)).toBe(true);
	});
});

describe('account lifecycle', () => {
	it('reports deployment metadata without authentication', async () => {
		const response = await SELF.fetch(url('/api/admin/meta'));
		expect(response.status).toBe(200);

		const body = (await response.json()) as { data: { hasAccounts: boolean; apiVersion: string; providers: Array<{ type: string }> } };
		expect(body.data.hasAccounts).toBe(false);
		expect(body.data.apiVersion).toBe(API_VERSION);
		expect(body.data.providers.map((provider) => provider.type)).toContain('caldav');
	});

	it('makes the first account an administrator and sets a hardened cookie', async () => {
		const response = await SELF.fetch(url('/api/admin/auth/signup'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: 'alice', password: 'password12345' }),
		});

		expect(response.status).toBe(200);
		const setCookie = response.headers.get('set-cookie') ?? '';
		expect(setCookie).toContain('muse_session=');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
		expect(setCookie).toContain('SameSite=Lax');

		const body = (await response.json()) as { data: { account: { isAdmin: boolean } } };
		expect(body.data.account.isAdmin).toBe(true);
	});

	it('does not make later accounts administrators', async () => {
		await signUp('alice');
		const response = await SELF.fetch(url('/api/admin/auth/signup'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: 'bob', password: 'password12345' }),
		});
		const body = (await response.json()) as { data: { account: { isAdmin: boolean } } };
		expect(body.data.account.isAdmin).toBe(false);
	});

	it('rejects short passwords and duplicate usernames', async () => {
		await signUp('alice');

		const weak = await SELF.fetch(url('/api/admin/auth/signup'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: 'carol', password: 'short' }),
		});
		expect(weak.status).toBe(400);

		const duplicate = await SELF.fetch(url('/api/admin/auth/signup'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: 'ALICE', password: 'password12345' }),
		});
		expect(duplicate.status).toBe(409);
	});
});

describe('login', () => {
	it('issues a session and requires it for admin routes', async () => {
		await signUp('alice');

		const anonymous = await SELF.fetch(url('/api/admin/connections'));
		expect(anonymous.status).toBe(401);

		const response = await login('alice', 'password12345');
		expect(response.status).toBe(200);
		const cookie = cookieFrom(response);

		const authenticated = await SELF.fetch(url('/api/admin/connections'), { headers: { cookie } });
		expect(authenticated.status).toBe(200);
	});

	it('does not reveal whether a username exists', async () => {
		await signUp('alice');

		const wrongPassword = await login('alice', 'not-the-password');
		const noSuchUser = await login('nobody-here', 'not-the-password');

		expect(wrongPassword.status).toBe(401);
		expect(noSuchUser.status).toBe(401);

		const a = (await wrongPassword.json()) as { error: { code: string; message: string } };
		const b = (await noSuchUser.json()) as { error: { code: string; message: string } };
		expect(a.error.code).toBe('invalid_credentials');
		expect(a.error).toEqual(b.error);
	});

	it('locks the account after repeated failures, even for the right password', async () => {
		await signUp('alice');

		for (let attempt = 0; attempt < 10; attempt++) {
			const response = await login('alice', 'wrong');
			expect(response.status).toBe(401);
		}

		const locked = await login('alice', 'password12345');
		expect(locked.status).toBe(429);
		const body = (await locked.json()) as { error: { code: string } };
		expect(body.error.code).toBe('account_locked');
	});

	it('logs out by clearing the session', async () => {
		const { cookie } = await signUp('alice');

		const logout = await SELF.fetch(url('/api/admin/auth/logout'), { method: 'POST', headers: { cookie } });
		expect(logout.status).toBe(200);
		expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

		const after = await SELF.fetch(url('/api/admin/auth/me'), { headers: { cookie } });
		expect(after.status).toBe(401);
	});

	it('invalidates other sessions when the password changes', async () => {
		await signUp('alice');
		const first = cookieFrom(await login('alice', 'password12345'));
		const second = cookieFrom(await login('alice', 'password12345'));

		const change = await SELF.fetch(url('/api/admin/auth/password'), {
			method: 'POST',
			headers: { cookie: first, 'content-type': 'application/json' },
			body: JSON.stringify({ currentPassword: 'password12345', newPassword: 'an-entirely-new-password' }),
		});
		expect(change.status).toBe(200);

		// The acting session is reissued; the other one is gone.
		expect((await SELF.fetch(url('/api/admin/auth/me'), { headers: { cookie: second } })).status).toBe(401);
		expect((await SELF.fetch(url('/api/admin/auth/me'), { headers: { cookie: cookieFrom(change) } })).status).toBe(200);
	});

	it('rejects a wrong current password', async () => {
		const { cookie } = await signUp('alice');
		const response = await SELF.fetch(url('/api/admin/auth/password'), {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ currentPassword: 'nope', newPassword: 'another-long-password' }),
		});
		expect(response.status).toBe(401);
	});
});

describe('malformed input is a client error, not a crash', () => {
	it('treats an undecodable session cookie as unauthenticated', async () => {
		// decodeURIComponent('%') throws. That used to escape parsing an untrusted
		// header and surface as a logged 500 whose message did not even name the
		// cookie; the request is simply not signed in.
		for (const value of ['%', '%zz', '%E0%A4%A']) {
			const response = await SELF.fetch(url('/api/admin/auth/me'), { headers: { cookie: `muse_session=${value}` } });
			expect(response.status).toBe(401);
		}
	});

	it('still accepts a well-formed cookie alongside a malformed one', async () => {
		const { cookie } = await signUp('alice');
		const response = await SELF.fetch(url('/api/admin/auth/me'), {
			headers: { cookie: `broken=%zz; ${cookie}` },
		});
		expect(response.status).toBe(200);
	});
});

describe('admin account list', () => {
	it('counts each account\'s connections, not its API keys', async () => {
		const { cookie, accountId } = await signUp('alice');

		// Seeded through the repository rather than the admin API: creating a
		// connection runs a live credential test against the upstream, which is not
		// what this assertion is about and would need the DAV mock.
		const connectionId = crypto.randomUUID();
		await repo.createConnection(env.DB, {
			id: connectionId,
			accountId,
			provider: 'caldav',
			label: 'Personal',
			authType: 'basic',
			username: 'alice@example.com',
			secretCiphertext: await encryptSecret('upstream-password', env),
			secretHint: '••••word',
			configJson: JSON.stringify({ baseUrl: 'https://dav.example.com/' }),
			now: Date.now(),
		});
		await adminOk(cookie, '/api/admin/keys', { method: 'POST', body: { name: 'agent one' } });
		await adminOk(cookie, '/api/admin/keys', { method: 'POST', body: { name: 'agent two' } });

		const listed = await adminOk<{ data: { accounts: Array<{ username: string; connectionCount: number }> } }>(
			cookie,
			'/api/admin/accounts',
		);
		// Two keys on one connection used to read as a connection count of two.
		expect(listed.data.accounts.find((account) => account.username === 'alice')?.connectionCount).toBe(1);
	});
});

describe('credential types are not interchangeable', () => {
	it('ignores an API key on the admin API', async () => {
		const response = await SELF.fetch(url('/api/admin/connections'), {
			headers: { authorization: 'Bearer muse_not_a_real_key' },
		});
		expect(response.status).toBe(401);
	});

	it('ignores a session cookie on the agent API', async () => {
		const { cookie } = await signUp('alice');
		const response = await SELF.fetch(url('/api/agent/notices'), { headers: { cookie } });
		expect(response.status).toBe(401);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe('unauthenticated');
	});

	it('rejects an unknown API key on the agent API', async () => {
		const response = await SELF.fetch(url('/api/agent/notices'), {
			headers: { authorization: 'Bearer muse_totally_made_up' },
		});
		expect(response.status).toBe(401);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe('invalid_key');
	});
});
