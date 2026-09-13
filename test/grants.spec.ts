import { describe, expect, it } from 'vitest';

import { effectiveAccess, expandWildcard, setAllCollections, setCollectionLevel, summarizeGrants, wildcardIn } from '../frontend/src/lib/grants';
import type { Connection, ConnectionResource, Grant } from '../frontend/src/lib/api';

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

function resource(connectionId: string, resourceKey: string, displayName: string | null): ConnectionResource {
	return { id: `${connectionId}:${resourceKey}`, resourceKey, kind: 'calendar', displayName, maxAccess: 'read', source: 'discovery' };
}

function connection(overrides: Partial<Connection> & Pick<Connection, 'id' | 'label'>): Connection {
	return {
		provider: 'baikal',
		username: 'muse',
		authType: 'basic',
		config: {},
		status: 'ok',
		lastError: null,
		secretHint: '\u2022\u2022\u2022\u2022',
		createdAt: 0,
		updatedAt: 0,
		resources: [],
		...overrides,
	};
}

/**
 * The key list used to print one pill per grant, so a key with a handful of
 * collections rendered a wall of resource keys — and raw UUIDs, because a DAV
 * path's last segment is a collection id. These pin the per-connection rollup
 * that replaced it.
 */
describe('grant summary', () => {
	const baikal = connection({
		id: CONNECTION,
		label: 'Baikal',
		resources: [
			resource(CONNECTION, 'dav.php/calendars/muse/270f', 'College Classes'),
			resource(CONNECTION, 'dav.php/calendars/muse/88bd', 'Assignments'),
		],
	});

	it('rolls one connection up into a single readable pill', () => {
		const summaries = summarizeGrants(
			[
				{ connectionId: CONNECTION, resourceKey: 'dav.php/calendars/muse/270f', maxAccess: 'read' },
				{ connectionId: CONNECTION, resourceKey: 'dav.php/calendars/muse/88bd', maxAccess: 'write' },
			],
			[baikal],
		);

		expect(summaries).toHaveLength(1);
		expect(summaries[0].text).toBe('Baikal \u00b7 2 collections \u00b7 read/write');
		expect(summaries[0].detail).toBe('College Classes \u00b7 read\nAssignments \u00b7 write');
	});

	it('calls a wildcard "all" and drops the count', () => {
		const summaries = summarizeGrants([{ connectionId: CONNECTION, resourceKey: '*', maxAccess: 'write' }], [baikal]);

		expect(summaries[0].text).toBe('Baikal \u00b7 all \u00b7 write');
		expect(summaries[0].detail).toBe('All collections \u00b7 write');
	});

	it('omits the count for a single collection', () => {
		const summaries = summarizeGrants(
			[{ connectionId: CONNECTION, resourceKey: 'dav.php/calendars/muse/270f', maxAccess: 'read' }],
			[baikal],
		);

		expect(summaries[0].text).toBe('Baikal \u00b7 read');
	});

	it('falls back to the last path segment and names an unknown connection', () => {
		const summaries = summarizeGrants(
			[
				{ connectionId: CONNECTION, resourceKey: 'dav.php/calendars/muse/ghost', maxAccess: 'read' },
				{ connectionId: OTHER, resourceKey: 'calendars/bob/work', maxAccess: 'write' },
			],
			[baikal],
		);

		expect(summaries.map((summary) => summary.text)).toEqual(['Baikal \u00b7 read', 'Unknown connection \u00b7 write']);
		expect(summaries[0].detail).toBe('ghost \u00b7 read');
		expect(summaries[1].detail).toBe('work \u00b7 write');
	});
});
