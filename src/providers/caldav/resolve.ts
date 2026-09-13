/**
 * DAV path resolution: the one thing this provider adds to the permission core.
 *
 * In the DAV family resources are collections addressed by URL path, so two
 * shapes need recognising that a protocol without a path hierarchy does not
 * have:
 *
 *   - a request inside a collection resolves to that collection, and the
 *     longest matching prefix wins (so /calendars/a/work/x.ics belongs to
 *     /calendars/a/work, not to a shorter sibling);
 *   - a request *above* every collection (the root, a principal, a home set) is
 *     an enumeration, not an unknown path. It needs blanket authority rather
 *     than being silently treated as unrelated.
 *
 * A prefix that is not a path boundary is unrelated: 'calendars/alice/workshop'
 * must never match 'calendars/alice/work'.
 */

import { normalizeResourceKey, type Resolution } from '../../lib/access';

export function resolveDavPath(path: string, resourceKeys: string[]): Resolution {
	const keys = resourceKeys.map(normalizeResourceKey);
	const target = normalizeResourceKey(path);

	let matched: string | null = null;
	for (const key of keys) {
		if (target === key || target.startsWith(key + '/')) {
			if (matched === null || key.length > matched.length) matched = key;
		}
	}
	if (matched !== null) return { resourceKey: matched, connectionScope: false };

	const isAncestorOfCollection = keys.some((key) => key.startsWith(target + '/'));
	if (target === '' || isAncestorOfCollection) return { resourceKey: null, connectionScope: true };

	return {
		resourceKey: null,
		connectionScope: false,
		reason: `'${path}' does not address any configured collection`,
	};
}
