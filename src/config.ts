/**
 * Environment parsing. Vars arrive as strings even when declared as booleans in
 * wrangler.jsonc, so everything is normalised here.
 */

import type { BaseUrlPolicy } from './lib/url';

export interface AppConfig {
	signupEnabled: boolean;
	pbkdf2Iterations: number;
	sessionTtlDays: number;
	allowPrivateNetworks: boolean;
	allowInsecureHttp: boolean;
	agentCorsOrigin: string;
}

export function boolVar(value: string | undefined, fallback = false): boolean {
	if (value === undefined || value === null) return fallback;
	return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

export function configFrom(env: Env): AppConfig {
	return {
		signupEnabled: boolVar(env.SIGNUP_ENABLED, true),
		pbkdf2Iterations: intVar(env.PBKDF2_ITERATIONS, 100_000, 1_000, 10_000_000),
		sessionTtlDays: intVar(env.SESSION_TTL_DAYS, 30, 1, 365),
		allowPrivateNetworks: boolVar(env.ALLOW_PRIVATE_NETWORKS, false),
		allowInsecureHttp: boolVar(env.ALLOW_INSECURE_HTTP, false),
		agentCorsOrigin: (env.AGENT_CORS_ORIGIN ?? '').trim(),
	};
}

export function urlPolicy(env: Env): BaseUrlPolicy {
	const config = configFrom(env);
	return {
		allowPrivateNetworks: config.allowPrivateNetworks,
		allowInsecureHttp: config.allowInsecureHttp,
	};
}
