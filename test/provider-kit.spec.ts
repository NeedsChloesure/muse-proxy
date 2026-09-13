import { afterAll, beforeAll, beforeEach } from 'vitest';

import { caldavProvider } from '../src/providers/caldav/provider';
import { dav } from './dav';
import { DAV, seedGateway } from './helpers';
import { providerConformance, type ProviderHarness } from './provider-kit';

/**
 * The CalDAV provider's harness for the conformance kit.
 *
 * Everything the kit cannot know lives here: how to seed a usable connection,
 * what a valid config looks like, and one request that must be refused because
 * the connection ceiling caps it at read.
 */
const harness: ProviderHarness = {
	provider: caldavProvider,
	seed: seedGateway,
	validConfig: () => ({ baseUrl: `${DAV}/` }),
	credentials: () => ({ username: 'alice@example.com', secret: 'conformance-secret-pw' }),
	denied: () => ({
		path: '/calendars/alice/work/new.ics',
		init: { method: 'PUT', headers: { 'content-type': 'text/calendar' }, body: 'BEGIN:VCALENDAR' },
	}),
};

beforeAll(() => dav.install());
afterAll(() => dav.uninstall());

beforeEach(() => {
	dav.reset();
	dav.discoveryDefaults();
});

providerConformance(harness);
