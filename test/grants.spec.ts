import { describe, expect, it } from 'vitest';

import { effectiveAccess, expandWildcard, setAllCollections, setCollectionLevel, wildcardIn } from '../frontend/src/lib/grants';
import type { Grant } from '../frontend/src/lib/api';

const CONNECTION = 'conn-1';
const OTHER = 'conn-2';
const CALENDARS = ['calendars/alice/work', 'calendars/alice/personal', 'calendars/alice/team'];

/**
 * The scope editor used to write a wildcard grant and then disable the
 * per-collection rows, which meant setting every collection at once locked the
 * individual ones: a key could never be "everything read except this calendar".
 * These pin the behaviour that replaced it.
 */
describe('scope matrix', () => {
	it('sets every collection with one choice', () => {
		const grants = setAllCollections([], CONNECTION, 'read');

		expect(wildcardIn(grants, CONNECTION)).toBe('read');
		for (const calendar of CALENDARS) expect(effectiveAccess(grants, CONNECTION, calendar)).toBe('read');
	});

	it('lets one collection be narrowed after everything was set', () => {
		const all = setAllCollections([], CONNECTION, 'read');
		const narrowed = setCollectionLevel(all, CONNECTION, 'calendars/alice/work', 'none', CALENDARS);

		expect(wildcardIn(narrowed, CONNECTION)).toBe('none');
		expect(effectiveAccess(narrowed, CONNECTION, 'calendars/alice/work')).toBe('none');
		// The rest keep the level the blanket choice asked for.
		for (const calendar of CALENDARS.slice(1)) expect(effectiveAccess(narrowed, CONNECTION, calendar)).toBe('read');
	});

	it('lets one collection be widened after everything was set', () => {
		const all = setAllCollections([], CONNECTION, 'read');
		const widened = setCollectionLevel(all, CONNECTION, 'calendars/alice/team', 'write', CALENDARS);

		expect(effectiveAccess(widened, CONNECTION, 'calendars/alice/team')).toBe('write');
		expect(effectiveAccess(widened, CONNECTION, 'calendars/alice/work')).toBe('read');
	});

	it('keeps narrowing possible one collection at a time', () => {
		let grants = setAllCollections([], CONNECTION, 'write');
		grants = setCollectionLevel(grants, CONNECTION, 'calendars/alice/work', 'read', CALENDARS);
		grants = setCollectionLevel(grants, CONNECTION, 'calendars/alice/personal', 'none', CALENDARS);

		expect(effectiveAccess(grants, CONNECTION, 'calendars/alice/work')).toBe('read');
		expect(effectiveAccess(grants, CONNECTION, 'calendars/alice/personal')).toBe('none');
		expect(effectiveAccess(grants, CONNECTION, 'calendars/alice/team')).toBe('write');
	});

	it('treats "all collections: none" as clearing the connection', () => {
		let grants = setAllCollections([], CONNECTION, 'write');
		grants = [...grants, { connectionId: OTHER, resourceKey: 'calendars/bob/work', maxAccess: 'read' }];
		grants = setCollectionLevel(grants, CONNECTION, 'calendars/alice/work', 'read', CALENDARS);

		const cleared = setAllCollections(grants, CONNECTION, 'none');
		expect(cleared.filter((grant) => grant.connectionId === CONNECTION)).toEqual([]);
		// Another connection is untouched.
		expect(cleared).toHaveLength(1);
		expect(cleared[0].connectionId).toBe(OTHER);
	});

	it('never loses access when expanding a wildcard', () => {
		const grants: Grant[] = [
			{ connectionId: CONNECTION, resourceKey: '*', maxAccess: 'read' },
			{ connectionId: CONNECTION, resourceKey: 'calendars/alice/work', maxAccess: 'write' },
			{ connectionId: OTHER, resourceKey: '*', maxAccess: 'write' },
		];

		const expanded = expandWildcard(grants, CONNECTION, CALENDARS);
		expect(wildcardIn(expanded, CONNECTION)).toBe('none');
		// The explicit grant was wider than the wildcard, so it survives as-is.
		expect(effectiveAccess(expanded, CONNECTION, 'calendars/alice/work')).toBe('write');
		expect(effectiveAccess(expanded, CONNECTION, 'calendars/alice/team')).toBe('read');
		// The other connection's own wildcard is not our business.
		expect(wildcardIn(expanded, OTHER)).toBe('write');
	});

	it('only touches the named collection when no wildcard is set', () => {
		const before: Grant[] = [{ connectionId: CONNECTION, resourceKey: 'calendars/alice/work', maxAccess: 'write' }];
		const after = setCollectionLevel(before, CONNECTION, 'calendars/alice/team', 'read', CALENDARS);

		expect(after).toHaveLength(2);
		expect(effectiveAccess(after, CONNECTION, 'calendars/alice/work')).toBe('write');
		expect(effectiveAccess(after, CONNECTION, 'calendars/alice/team')).toBe('read');
	});
});
