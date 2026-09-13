/**
 * The provider contract.
 *
 * Adding a service means adding one directory plus one registry entry. The
 * router, the permission core and the notice system never learn its name.
 *
 * The division of labour is what keeps this general:
 *
 *   - the router owns <connectionId> routing, account isolation and loading the
 *     two permission layers (src/providers/gateway.ts);
 *   - the core owns the intersection (src/lib/access.ts);
 *   - the provider owns only its own vocabulary: how a request maps to a
 *     resource and an access level, how its connection is configured, and how
 *     to talk to the upstream service.
 */

import type { Access, Account, ApiKey, Connection, DiscoveredResource } from '../types';
import type { AccessDecision, GrantEntry, Resolution, ScopeEntry } from '../lib/access';

export type { DiscoveredResource };

/** The stored credential pair. `username` is null for token-only auth types. */
export interface ProviderCredentials {
	username: string | null;
	secret: string;
}

/**
 * A configuration field a connection needs, declared once and used twice: the
 * console renders it, and the server validates it. That is what lets a new
 * provider appear in the UI without touching frontend code.
 */
export interface ProviderField {
	name: string;
	label: string;
	type: 'text' | 'url' | 'number' | 'password' | 'select';
	required?: boolean;
	placeholder?: string;
	help?: string;
	/** Allowed values, for type 'select'. */
	options?: string[];
	default?: string;
}

/** How the console should label the stored credential pair. */
export interface ProviderCredentialFields {
	usernameLabel: string;
	secretLabel: string;
	/** False for providers whose auth type carries no username (e.g. bearer). */
	usernameRequired: boolean;
	help?: string;
}

/** Context for admin-side operations (test, discover) on one connection. */
export interface AdminProviderCtx {
	env: Env;
	connectionId: string;
	/** Provider-owned configuration: base URL, host, port, … */
	config: Record<string, unknown>;
	credentials: ProviderCredentials;
	authType: string;
}

export type TestResult = { ok: true } | { ok: false; error: string };

/** Result of an agent request. */
export interface ProviderResult {
	response: Response;
}

/**
 * Context for an authenticated agent request, already scoped to one connection.
 *
 * The connection, its ACL and this key's grants are resolved by the router
 * before dispatch, so a provider never queries for them and cannot get account
 * isolation wrong.
 */
export interface AgentCtx {
	env: Env;
	request: Request;
	key: ApiKey;
	account: Account;
	/** The addressed connection, already checked to belong to the account. */
	connection: Connection;
	/** The connection's ACL. */
	scope: ScopeEntry[];
	/** This key's grants on the connection. */
	grants: GrantEntry[];
	/** Path remainder after `<connectionId>/`, percent-encoding intact. */
	rawPath: string;
	/** Resolve access for one request without enforcing anything. */
	decide(resolution: Resolution): AccessDecision;
	/**
	 * Throw the standard guided 403 unless a decision covers `required`. The
	 * override message is for cases like a MOVE destination, where the refusal
	 * needs to name which end of the request failed.
	 */
	require(decision: AccessDecision, required: Exclude<Access, 'none'>, message?: string): void;
}

export interface OpenApiFragment {
	paths: Record<string, unknown>;
	components?: Record<string, unknown>;
}

export interface ServiceProvider {
	readonly type: string;
	readonly displayName: string;
	readonly summary: string;
	readonly docsPath: string;
	readonly openapiPath: string;
	readonly defaultAuthType: string;
	/** Config fields the console renders, and the shape validateConfig returns. */
	readonly fields: readonly ProviderField[];
	/** Labels for the stored credential pair. */
	readonly credentials: ProviderCredentialFields;

	/** Normalise and validate provider-specific config. Throws HttpError. */
	validateConfig(input: unknown): Record<string, unknown>;

	/** Enforce the SSRF policy on whatever this provider dials. Throws HttpError. */
	verifyConfig(config: Record<string, unknown>, env: Env): void;

	/** Confirm the stored credentials work upstream. */
	test(ctx: AdminProviderCtx): Promise<TestResult>;

	/** Discover the scope universe: the resources a key can be granted. */
	discover(ctx: AdminProviderCtx): Promise<DiscoveredResource[]>;

	/** Handle an authenticated agent request inside this provider's URL space. */
	handle(ctx: AgentCtx): Promise<ProviderResult>;

	/** OpenAPI 3.1 fragment for this provider's agent routes. */
	openapi(): OpenApiFragment;
}
