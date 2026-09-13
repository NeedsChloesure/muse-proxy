/**
 * Shared gateway plumbing: connection routing and authorization.
 *
 * Both live here rather than in each provider because both are places where a
 * mistake becomes a cross-account or privilege-escalation bug. Before this
 * module existed each provider had to remember to scope its connection lookup by
 * account, remember to load both permission layers, and remember to spell the
 * refusal the same way. Now it cannot forget.
 */

import { getConnectionForAccount, listGrantsForKeyConnection, listResources } from '../db/repo';
import { ACCESS_RANK, type Access, type Account, type ApiKey, type Connection } from '../types';
import { HttpError } from '../lib/http';
import { permittedResources, type AccessDecision, type GrantEntry, type ScopeEntry } from '../lib/access';
import type { ServiceProvider } from './types';

export interface ConnectionRoute {
	connection: Connection;
	scope: ScopeEntry[];
	grants: GrantEntry[];
	/** Path remainder after `<connectionId>/`. */
	rawPath: string;
}

/**
 * Split `<connectionId>/<rest>` and load everything the decision needs.
 *
 * The key is already authenticated when this runs. Account scoping is applied
 * in SQL, so another account's connection is simply not found — a caller cannot
 * tell "exists but not yours" from "does not exist".
 */
export async function resolveConnectionRoute(
	env: Env,
	key: ApiKey,
	account: Account,
	provider: ServiceProvider,
	rawPath: string,
): Promise<ConnectionRoute> {
	const slash = rawPath.indexOf('/');
	const rest = slash === -1 ? '/' : rawPath.slice(slash);

	// The id comes straight off the request line, so it can carry malformed
	// percent-encoding, which decodeURIComponent reports by throwing. That is a
	// bad request, not an internal error.
	let connectionId: string;
	try {
		connectionId = decodeURIComponent(slash === -1 ? rawPath : rawPath.slice(0, slash));
	} catch {
		throw new HttpError(400, 'invalid_path', 'The connection id contains malformed percent-encoding.');
	}

	if (!connectionId) {
		throw new HttpError(404, 'not_found', `Address a connection: /api/agent/${provider.type}/<connectionId>/<path>.`);
	}

	const connection = await getConnectionForAccount(env.DB, connectionId, account.id);
	if (!connection) throw new HttpError(404, 'not_found', 'No such connection.');

	if (connection.provider !== provider.type) {
		throw new HttpError(
			400,
			'wrong_provider',
			`Connection '${connection.label}' is a ${connection.provider} connection, not ${provider.type}.`,
		);
	}

	const grants = await listGrantsForKeyConnection(env.DB, key.id, connectionId);
	if (grants.length === 0) {
		throw new HttpError(403, 'no_grant', `This API key has no grant on connection '${connection.label}'.`, {
			connectionId,
			hint: 'Grant this key access to the connection in the Muse Proxy frontend.',
		});
	}

	const resources = await listResources(env.DB, connectionId);
	return {
		connection,
		scope: resources.map((resource) => ({ resourceKey: resource.resourceKey, maxAccess: resource.maxAccess })),
		grants: grants.map((grant) => ({ resourceKey: grant.resourceKey, maxAccess: grant.maxAccess })),
		rawPath: rest,
	};
}

/**
 * Throw the standard guided 403 unless a decision covers `required`.
 *
 * The refusal names what was required, what the key actually has, every
 * resource it may use instead, and why — so an agent can correct itself instead
 * of retrying blindly. Keeping that shape in one place is the point.
 *
 * Split from `decideAccess` because a provider sometimes needs the decision
 * without enforcing it: OPTIONS is answered locally from the same decision, so
 * a client can plan a write without being refused for probing.
 */
export function requireAccess(input: {
	scope: ScopeEntry[];
	grants: GrantEntry[];
	decision: AccessDecision;
	required: Exclude<Access, 'none'>;
	message?: string;
}): AccessDecision {
	const { decision, required } = input;
	if (ACCESS_RANK[decision.access] >= ACCESS_RANK[required]) return decision;

	throw new HttpError(403, 'insufficient_access', input.message ?? describe(required, decision), {
		required,
		effective: decision.access,
		resource: decision.resourceKey,
		reason: decision.reason,
		permittedResources: permittedResources(input.scope, input.grants, required),
	});
}

function describe(required: Exclude<Access, 'none'>, decision: AccessDecision): string {
	if (decision.resourceKey === null) {
		return `This key has ${decision.access} access to the connection but ${required} is required.`;
	}
	if (decision.access === 'none') {
		return `This key may not access '${decision.resourceKey}' (${decision.reason}).`;
	}
	return `This key has ${decision.access} access to '${decision.resourceKey}' but ${required} is required.`;
}

/**
 * Read a required string out of a provider's own config.
 *
 * Config is provider-owned, so providers do the reading; this exists only so a
 * missing field fails with a clear 400 rather than an `undefined` travelling
 * toward an upstream request.
 */
export function configString(config: Record<string, unknown>, name: string): string {
	const value = config[name];
	if (typeof value === 'string' && value.length > 0) return value;
	throw new HttpError(400, 'invalid_request', `This connection is missing its '${name}' configuration.`);
}
