/**
 * Permission resolution — the security core of the gateway.
 *
 * Authority is the INTERSECTION of two independent layers:
 *
 *   1. the connection ACL: what the stored upstream credential is ever allowed
 *      to do, per resource;
 *   2. the key grant: what this particular agent key may do, per resource.
 *
 * Neither can widen the other, and both default to deny. Everything here is a
 * pure function so the matrix can be tested exhaustively.
 *
 * This module deliberately knows nothing about URLs, methods or protocols. A
 * provider translates its own request shape (a DAV path, a mailbox name, a
 * table) into a Resolution and the core decides. That is what keeps the
 * intersection — the part you must never get wrong — in one tested place
 * instead of re-implemented per provider.
 */

import { type Access, ACCESS_RANK, minAccess } from '../types';

/** The subset of a connection's ACL the resolver needs. */
export interface ScopeEntry {
	resourceKey: string;
	maxAccess: Access;
}

/** The subset of a key's grant the resolver needs. */
export interface GrantEntry {
	resourceKey: string;
	maxAccess: Exclude<Access, 'none'>;
}

/**
 * A provider's translation of an inbound request into the core's vocabulary.
 *
 * A provider resolves its request into exactly one of three shapes:
 *   - a specific resource (`resourceKey` set);
 *   - the whole connection (`connectionScope: true`), which enumerates;
 *   - neither, which is denied (an unrelated path, an unknown mailbox).
 */
export interface Resolution {
	/** The resource this request addresses, or null when it spans the connection. */
	resourceKey: string | null;
	/** True when the request deliberately addresses every resource at once. */
	connectionScope: boolean;
	/** Provider wording for a denial, surfaced to the agent. */
	reason?: string;
}

export interface AccessDecision {
	/** Authority for this request. */
	access: Access;
	/** The resource the request was attributed to, if any. */
	resourceKey: string | null;
	/** Human-readable explanation, surfaced to agents on denial. */
	reason: string;
	/** True when the decision was made against the whole connection. */
	connectionScope: boolean;
}

/** Resource keys are opaque strings; only this canonical form is compared. */
export function normalizeResourceKey(key: string): string {
	return key.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function accessForResource(scope: ScopeEntry[], grants: GrantEntry[], resourceKey: string): Access {
	const key = normalizeResourceKey(resourceKey);

	// Layer 1: the connection's own ceiling for this resource.
	let access: Access = 'none';
	for (const entry of scope) {
		if (normalizeResourceKey(entry.resourceKey) === key) {
			access = entry.maxAccess;
			break;
		}
	}
	if (access === 'none') return 'none';

	// Layer 2: the key's grant, either for this resource or a wildcard.
	let granted: Access = 'none';
	for (const grant of grants) {
		const gk = grant.resourceKey === '*' ? '*' : normalizeResourceKey(grant.resourceKey);
		if (gk === key || gk === '*') granted = maxAccess(granted, grant.maxAccess);
	}

	return minAccess(access, granted);
}

function maxAccess(a: Access, b: Access): Access {
	return ACCESS_RANK[a] >= ACCESS_RANK[b] ? a : b;
}

/**
 * Blanket access for requests that span the whole connection.
 *
 * Requires a wildcard grant AND every known resource to be permitted, so a
 * request that enumerates cannot surface one the key may not read. With no
 * resources known yet there is nothing to leak, so the wildcard grant alone
 * decides — that keeps first-run discovery usable.
 */
export function accessForConnection(scope: ScopeEntry[], grants: GrantEntry[]): Access {
	const wildcard = grants.filter((grant) => grant.resourceKey === '*');
	if (wildcard.length === 0) return 'none';
	const granted = wildcard.reduce<Access>((acc, grant) => maxAccess(acc, grant.maxAccess), 'none');

	if (scope.length === 0) return granted;

	let blanket: Access = 'write';
	for (const entry of scope) {
		blanket = minAccess(blanket, minAccess(entry.maxAccess, granted));
	}
	return blanket;
}

/** Resolve one provider-supplied request into the access it carries. */
export function decideAccess(scope: ScopeEntry[], grants: GrantEntry[], resolution: Resolution): AccessDecision {
	if (resolution.resourceKey !== null) {
		const access = accessForResource(scope, grants, resolution.resourceKey);
		return {
			access,
			resourceKey: normalizeResourceKey(resolution.resourceKey),
			reason: resolution.reason ?? (access === 'none' ? `no grant covers '${resolution.resourceKey}'` : 'resource grant'),
			connectionScope: false,
		};
	}

	if (!resolution.connectionScope) {
		return {
			access: 'none',
			resourceKey: null,
			reason: resolution.reason ?? 'this request does not address any configured resource',
			connectionScope: false,
		};
	}

	const access = accessForConnection(scope, grants);
	return {
		access,
		resourceKey: null,
		reason:
			resolution.reason ??
			(access === 'none'
				? 'this request spans every resource, which requires a wildcard grant plus a connection-level permission on each'
				: 'wildcard grant covering the whole connection'),
		connectionScope: true,
	};
}

/**
 * Resource keys a key may reach at or above a level, for the guided 403 body.
 *
 * Keys are returned in their canonical form and nothing more: the core does not
 * know how a provider addresses them, so it must not invent a URL shape.
 */
export function permittedResources(
	scope: ScopeEntry[],
	grants: GrantEntry[],
	atLeast: Exclude<Access, 'none'>,
): string[] {
	return scope
		.filter((entry) => ACCESS_RANK[accessForResource(scope, grants, entry.resourceKey)] >= ACCESS_RANK[atLeast])
		.map((entry) => normalizeResourceKey(entry.resourceKey));
}
