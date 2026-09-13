/**
 * The key grant matrix, as pure functions.
 *
 * A key's authority is the intersection of two layers: the connection's ceiling
 * for a collection, and the key's own grant. This module models the second one.
 *
 * A grant is either for a single collection (`calendars/alice/work`) or for the
 * whole connection (`'*'`). Those two are UNIONED — the wildcard cannot be
 * narrowed by also naming a collection — so a key set to "all collections: read"
 * could never have one calendar lowered to nothing by adding a grant.
 *
 * That is why the editor treats the wildcard as a bulk convenience rather than a
 * mode: the moment one collection is tuned, the wildcard is expanded into
 * explicit grants for the collections that exist now, and the tuning applies.
 * Without that, setting everything at once would lock the individual rows.
 */

import type { Access, Connection, Grant, GrantAccess } from './api';

const RANK: Record<Access, number> = { none: 0, read: 1, write: 2 };

function higher(a: Access, b: Access): Access {
	return RANK[a] >= RANK[b] ? a : b;
}

/** The grant for one collection, ignoring any wildcard. */
export function levelIn(grants: Grant[], connectionId: string, resourceKey: string): Access {
	return grants.find((grant) => grant.connectionId === connectionId && grant.resourceKey === resourceKey)?.maxAccess ?? 'none';
}

/** The connection-wide grant, if one is set. */
export function wildcardIn(grants: Grant[], connectionId: string): Access {
	return levelIn(grants, connectionId, '*');
}

/** What the gateway would actually allow, for display only. */
export function effectiveAccess(grants: Grant[], connectionId: string, resourceKey: string): Access {
	return higher(wildcardIn(grants, connectionId), levelIn(grants, connectionId, resourceKey));
}

function withLevel(grants: Grant[], connectionId: string, resourceKey: string, level: Access): Grant[] {
	const rest = grants.filter((grant) => !(grant.connectionId === connectionId && grant.resourceKey === resourceKey));
	return level === 'none' ? rest : [...rest, { connectionId, resourceKey, maxAccess: level }];
}

/**
 * Replace a connection's wildcard with explicit grants for the collections that
 * exist now.
 *
 * Nothing is lost in the process: a collection that already carried its own
 * grant keeps whichever of the two is wider.
 */
export function expandWildcard(grants: Grant[], connectionId: string, resourceKeys: readonly string[]): Grant[] {
	const level = wildcardIn(grants, connectionId);
	if (level === 'none') return grants;

	const elsewhere = grants.filter((grant) => grant.connectionId !== connectionId);
	const held = new Map(
		grants.filter((grant) => grant.connectionId === connectionId && grant.resourceKey !== '*').map((grant) => [grant.resourceKey, grant.maxAccess]),
	);
	const expanded = resourceKeys.map((resourceKey) => ({
		connectionId,
		resourceKey,
		maxAccess: higher(held.get(resourceKey) ?? 'none', level) as GrantAccess,
	}));

	return [...elsewhere, ...expanded];
}

/**
 * Set one collection's level. A wildcard in the way is expanded first, so the
 * choice applies instead of being swallowed by the union.
 */
export function setCollectionLevel(
	grants: Grant[],
	connectionId: string,
	resourceKey: string,
	level: Access,
	resourceKeys: readonly string[],
): Grant[] {
	return withLevel(expandWildcard(grants, connectionId, resourceKeys), connectionId, resourceKey, level);
}

/**
 * Set every collection at once, as a wildcard so collections discovered later
 * are covered too. Individual grants for the connection are cleared: the answer
 * to "all collections" is exactly one level, not a pile of older ones.
 */
export function setAllCollections(grants: Grant[], connectionId: string, level: Access): Grant[] {
	const elsewhere = grants.filter((grant) => grant.connectionId !== connectionId);
	return level === 'none' ? elsewhere : [...elsewhere, { connectionId, resourceKey: '*', maxAccess: level }];
}

/** One connection's slice of a key's grants, boiled down for a list view. */
export interface GrantSummary {
	connectionId: string;
	/** Human label for the connection the grants belong to. */
	label: string;
	/** Compact pill text, e.g. `Baikal · read` or `Baikal · all · write`. */
	text: string;
	/** Every granted collection and level, for the pill's title attribute. */
	detail: string;
}

const LEVEL_RANK: Record<GrantAccess, number> = { read: 1, write: 2 };

/**
 * Roll a key's grants up by connection for the key list.
 *
 * The list has one row per key, so printing every grant there produced a wall
 * of resource keys — and opaque UUIDs, because a DAV path's last segment is a
 * collection id. Grouping by connection and resolving the display name the
 * connection already knows keeps the cell scannable; `detail` carries the full
 * list for the pill's tooltip.
 */
export function summarizeGrants(grants: readonly Grant[], connections: readonly Connection[]): GrantSummary[] {
	const byConnection = new Map<string, Grant[]>();
	for (const grant of grants) {
		const existing = byConnection.get(grant.connectionId);
		if (existing) existing.push(grant);
		else byConnection.set(grant.connectionId, [grant]);
	}

	return [...byConnection].map(([connectionId, list]) => {
		const connection = connections.find((entry) => entry.id === connectionId);
		const label = connection?.label ?? 'Unknown connection';
		// A wildcard already covers every collection, so naming the count would
		// only be noise — and the explicit grants it sits beside are a subset.
		const wildcard = list.some((grant) => grant.resourceKey === '*');
		const levels = [...new Set(list.map((grant) => grant.maxAccess))].sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]);
		const scope = wildcard ? 'all' : list.length > 1 ? `${list.length} collections` : null;

		return {
			connectionId,
			label,
			text: [label, scope, levels.join('/')].filter(Boolean).join(' · '),
			detail: list.map((grant) => `${collectionName(connection, grant.resourceKey)} · ${grant.maxAccess}`).join('\n'),
		};
	});
}

/** The name a person would recognise, falling back to the path's last segment. */
function collectionName(connection: Connection | undefined, resourceKey: string): string {
	if (resourceKey === '*') return 'All collections';
	const resource = connection?.resources.find((entry) => entry.resourceKey === resourceKey);
	return resource?.displayName ?? resourceKey.split('/').filter(Boolean).pop() ?? resourceKey;
}
