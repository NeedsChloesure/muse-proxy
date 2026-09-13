/**
 * The provider registry.
 *
 * Adding a service is a one-line change here plus a new directory. Nothing in
 * the router, the ACL core or the notice system needs to know it exists beyond
 * its entry in this list.
 */

import { caldavProvider } from './caldav/provider';
import type { ServiceProvider } from './types';

const PROVIDERS: ServiceProvider[] = [caldavProvider];

const BY_TYPE = new Map(PROVIDERS.map((provider) => [provider.type, provider]));

export function getProvider(type: string): ServiceProvider | undefined {
	return BY_TYPE.get(type);
}

export function allProviders(): ServiceProvider[] {
	return PROVIDERS;
}

export function providerTypes(): string[] {
	return PROVIDERS.map((provider) => provider.type);
}
