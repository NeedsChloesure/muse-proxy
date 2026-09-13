import { describe, expect, it } from 'vitest';

import {
	accessForConnection,
	accessForResource,
	decideAccess,
	permittedResources,
	type GrantEntry,
	type Resolution,
	type ScopeEntry,
} from '../src/lib/access';

/**
 * The security core. Authority is the INTERSECTION of the connection ceiling and
 * the key's grants, deny by default on both sides.
 *
 * The core is protocol-neutral: a provider translates its own request shape
 * into a Resolution, and nothing here knows what a path is.
 */

const scope: ScopeEntry[] = [
	{ resourceKey: 'calendars/alice/work', maxAccess: 'read' },
	{ resourceKey: 'calendars/alice/home', maxAccess: 'write' },
	{ resourceKey: 'addressbooks/alice/people', maxAccess: 'none' },
];

const onResource = (resourceKey: string): Resolution => ({ resourceKey, connectionScope: false });
const onConnection: Resolution = { resourceKey: null, connectionScope: true };
const nothing: Resolution = { resourceKey: null, connectionScope: false };

describe('accessForResource', () => {
	const grants: GrantEntry[] = [{ resourceKey: 'calendars/alice/work', maxAccess: 'write' }];

	it('never lets a key exceed the connection ceiling', () => {
		// write grant, but the connection only permits read
		expect(accessForResource(scope, grants, 'calendars/alice/work')).toBe('read');
	});

	it('never lets a connection widen a key', () => {
		const narrow: GrantEntry[] = [{ resourceKey: 'calendars/alice/home', maxAccess: 'read' }];
		expect(accessForResource(scope, narrow, 'calendars/alice/home')).toBe('read');
	});

	it('denies by default when either layer is missing', () => {
		expect(accessForResource(scope, [], 'calendars/alice/work')).toBe('none');
		expect(accessForResource(scope, grants, 'calendars/alice/unknown')).toBe('none');
		// The connection explicitly disables this one.
		expect(accessForResource(scope, [{ resourceKey: '*', maxAccess: 'write' }], 'addressbooks/alice/people')).toBe('none');
	});

	it('honours a wildcard grant', () => {
		expect(accessForResource(scope, [{ resourceKey: '*', maxAccess: 'read' }], 'calendars/alice/home')).toBe('read');
		expect(accessForResource(scope, [{ resourceKey: '*', maxAccess: 'write' }], 'calendars/alice/home')).toBe('write');
	});

	it('takes the widest matching grant', () => {
		const mixed: GrantEntry[] = [
			{ resourceKey: '*', maxAccess: 'read' },
			{ resourceKey: 'calendars/alice/home', maxAccess: 'write' },
		];
		expect(accessForResource(scope, mixed, 'calendars/alice/home')).toBe('write');
	});

	it('works for resources that are not paths', () => {
		// A provider with no path hierarchy — mailboxes, tables, collection names —
		// uses the same core unchanged: a resource key is an opaque string.
		const mailboxes: ScopeEntry[] = [
			{ resourceKey: 'INBOX', maxAccess: 'read' },
			{ resourceKey: 'Sent', maxAccess: 'none' },
		];
		const wildcard: GrantEntry[] = [{ resourceKey: '*', maxAccess: 'write' }];

		expect(accessForResource(mailboxes, wildcard, 'INBOX')).toBe('read');
		expect(accessForResource(mailboxes, wildcard, 'Sent')).toBe('none');
		expect(accessForResource(mailboxes, wildcard, 'Archive')).toBe('none');
		expect(decideAccess(mailboxes, wildcard, onResource('INBOX')).access).toBe('read');
	});
});

describe('accessForConnection', () => {
	it('requires a wildcard grant', () => {
		const specific: GrantEntry[] = [
			{ resourceKey: 'calendars/alice/work', maxAccess: 'write' },
			{ resourceKey: 'calendars/alice/home', maxAccess: 'write' },
		];
		expect(accessForConnection(scope, specific)).toBe('none');
	});

	it('requires every resource to be permitted, so enumeration cannot leak one', () => {
		// The wildcard grant is wide, but 'addressbooks/alice/people' is disabled
		// at the connection level, so the whole-connection answer is none.
		expect(accessForConnection(scope, [{ resourceKey: '*', maxAccess: 'write' }])).toBe('none');
	});

	it('reports the narrowest level across resources', () => {
		const limited: ScopeEntry[] = [
			{ resourceKey: 'a', maxAccess: 'write' },
			{ resourceKey: 'b', maxAccess: 'read' },
		];
		expect(accessForConnection(limited, [{ resourceKey: '*', maxAccess: 'write' }])).toBe('read');
	});

	it('allows discovery on a connection with no resources yet', () => {
		// Nothing exists, so nothing can leak.
		expect(accessForConnection([], [{ resourceKey: '*', maxAccess: 'read' }])).toBe('read');
		expect(accessForConnection([], [])).toBe('none');
	});
});

describe('decideAccess', () => {
	const grants: GrantEntry[] = [
		{ resourceKey: 'calendars/alice/work', maxAccess: 'write' },
		{ resourceKey: 'calendars/alice/home', maxAccess: 'read' },
	];

	it('reports the resource and level for a resource request', () => {
		expect(decideAccess(scope, grants, onResource('calendars/alice/work'))).toMatchObject({
			access: 'read',
			resourceKey: 'calendars/alice/work',
			connectionScope: false,
		});
		expect(decideAccess(scope, grants, onResource('calendars/alice/home'))).toMatchObject({
			access: 'read',
			resourceKey: 'calendars/alice/home',
		});
	});

	it('canonicalises a resource key the provider supplies with slashes', () => {
		expect(decideAccess(scope, grants, onResource('/calendars/alice/work/')).resourceKey).toBe('calendars/alice/work');
	});

	it('refuses a connection-scoped request without a wildcard grant', () => {
		const decision = decideAccess(scope, grants, onConnection);
		expect(decision.access).toBe('none');
		expect(decision.connectionScope).toBe(true);
		expect(decision.reason).toContain('wildcard');
	});

	it('refuses a resolution that addresses nothing', () => {
		const decision = decideAccess(scope, [{ resourceKey: '*', maxAccess: 'write' }], nothing);
		expect(decision.access).toBe('none');
		expect(decision.reason).toContain('does not address');
	});

	it('lets the provider phrase its own refusal', () => {
		// Providers know their own vocabulary; the core does not invent one.
		const decision = decideAccess(scope, grants, { ...nothing, reason: "'/principals/bob/' is not a collection" });
		expect(decision.reason).toBe("'/principals/bob/' is not a collection");
	});

	it('allows a connection-scoped request with a wildcard grant on a fully permitted connection', () => {
		const open: ScopeEntry[] = [
			{ resourceKey: 'a', maxAccess: 'read' },
			{ resourceKey: 'b', maxAccess: 'write' },
		];
		expect(decideAccess(open, [{ resourceKey: '*', maxAccess: 'write' }], onConnection).access).toBe('read');
	});
});

describe('permittedResources', () => {
	it('lists only resources meeting the required level', () => {
		// work is write at the connection but read at the key, so it stays read;
		// home is write on both, so it reaches write.
		const grants: GrantEntry[] = [
			{ resourceKey: 'calendars/alice/work', maxAccess: 'write' },
			{ resourceKey: 'calendars/alice/home', maxAccess: 'write' },
		];
		expect(permittedResources(scope, grants, 'write')).toEqual(['calendars/alice/home']);
		expect(permittedResources(scope, grants, 'read')).toEqual(['calendars/alice/work', 'calendars/alice/home']);
	});

	it('returns keys in canonical form, without inventing a URL shape', () => {
		const grants: GrantEntry[] = [{ resourceKey: '*', maxAccess: 'write' }];
		expect(permittedResources([{ resourceKey: '/calendars/alice/work/', maxAccess: 'write' }], grants, 'read')).toEqual([
			'calendars/alice/work',
		]);
	});
});
