import { describe, expect, it } from 'vitest';

import { SUSPECT_WINDOW_DAYS, dayFloor, keyUsageState, usageDisplay, usedDaysAgo, usedDaysLabel } from '../frontend/src/lib/keyActivity';

const NOW = Date.UTC(2026, 8, 13, 15, 0, 0); // 2026-09-13T15:00Z
const DAY = 86_400_000;
const BEFORE = NOW - 30 * DAY;

/**
 * The activity log used to answer "what did my agent do?"; it was removed as a
 * storage footgun. `last_used_at` is what remains, and these pin the states the
 * dashboard derives from it — in particular the one worth shouting about: an
 * expired key that was in active use right up until it died. (Revocation is
 * deletion, so a deleted key leaves the list entirely and needs no state.)
 */
describe('key usage flagging', () => {
	it('measures whole days at day resolution', () => {
		// Earlier today is 0 days ago (15:00 minus 2h is still the 13th)...
		expect(usedDaysAgo(NOW - 2 * 60 * 60 * 1000, NOW)).toBe(0);
		// ...but 23h back crosses midnight, so it is 1 day ago.
		expect(usedDaysAgo(NOW - 23 * 60 * 60 * 1000, NOW)).toBe(1);
		expect(usedDaysAgo(NOW - 25 * 60 * 60 * 1000, NOW)).toBe(1);
		expect(usedDaysAgo(NOW - 8 * DAY, NOW)).toBe(8);
	});

	it('floors a timestamp to its UTC day', () => {
		expect(dayFloor(NOW)).toBe(Date.UTC(2026, 8, 13));
		expect(dayFloor(Date.UTC(2026, 8, 12, 23, 59))).toBe(Date.UTC(2026, 8, 12));
	});

	it('calls a live key active whatever its last use was', () => {
		expect(keyUsageState({ expiresAt: null, lastUsedAt: NOW - 1000 }, NOW)).toBe('active');
		// A live key with an ancient use is simply active, not interesting.
		expect(keyUsageState({ expiresAt: null, lastUsedAt: BEFORE }, NOW)).toBe('active');
	});

	it('distinguishes a never-used key from one that went quiet', () => {
		expect(keyUsageState({ expiresAt: null, lastUsedAt: null }, NOW)).toBe('unused');
		// A live key that has gone quiet is still just active: dormancy is visible
		// in the Last-used column, and it is not a warning — the flag exists for
		// dead keys whose credential was in use at the end.
		expect(keyUsageState({ expiresAt: null, lastUsedAt: BEFORE }, NOW)).toBe('active');
	});

	it('flags a dead key whose credential was in use when it died', () => {
		// Expired yesterday, last used two hours before that.
		const expired = { expiresAt: NOW - DAY, lastUsedAt: NOW - DAY - 2 * 60 * 60 * 1000 };
		expect(keyUsageState(expired, NOW)).toBe('suspect');

		// Expired two days ago, last used the day before expiry.
		const older = { expiresAt: NOW - 2 * DAY, lastUsedAt: NOW - 3 * DAY };
		expect(keyUsageState(older, NOW)).toBe('suspect');
	});

	it('lets a dead key that went quiet before it died stay quiet', () => {
		// A key that had already fallen out of use when it expired is
		// housekeeping, not an incident.
		const housekeeping = { expiresAt: NOW - DAY, lastUsedAt: BEFORE };
		expect(keyUsageState(housekeeping, NOW)).toBe('stale');
	});

	it('stops shouting once the frozen timestamp ages out of the window', () => {
		const aged = { expiresAt: NOW - 3 * DAY, lastUsedAt: NOW - 3 * DAY };
		expect(keyUsageState(aged, NOW)).toBe('suspect');
		expect(keyUsageState({ expiresAt: NOW - 8 * DAY, lastUsedAt: NOW - 8 * DAY }, NOW)).toBe('stale');
	});

	it('treats the boundary day as inside the window', () => {
		// Used exactly 6 days ago: the last day a 7-day window covers.
		const inside = { expiresAt: NOW - DAY, lastUsedAt: NOW - (SUSPECT_WINDOW_DAYS - 1) * DAY };
		expect(keyUsageState(inside, NOW)).toBe('suspect');
		// 7 days back is the first day outside it.
		const outside = { expiresAt: NOW - DAY, lastUsedAt: NOW - SUSPECT_WINDOW_DAYS * DAY };
		expect(keyUsageState(outside, NOW)).toBe('stale');
	});
});

describe('usage display', () => {
	const formatRecent = (timestamp: number) => `${Math.round((NOW - timestamp) / 60_000)}m ago`;

	it('shows a suspect key with a loud pill and day wording', () => {
		const display = usageDisplay({ expiresAt: NOW - DAY, lastUsedAt: NOW - DAY }, NOW, formatRecent);
		expect(display.pill).toEqual({ text: 'recently active', tone: 'warn' });
		expect(display.used).toBe('1d ago');
	});

	it('keeps the friendly wording for live keys', () => {
		const display = usageDisplay({ expiresAt: null, lastUsedAt: NOW - 5 * 60_000 }, NOW, formatRecent);
		expect(display.pill).toBeNull();
		expect(display.used).toBe('5m ago');
	});

	it('uses day wording for a quiet dead key and nothing for never', () => {
		const stale = usageDisplay({ expiresAt: NOW - DAY, lastUsedAt: BEFORE }, NOW, formatRecent);
		expect(stale.pill).toBeNull();
		expect(stale.used).toBe('30d ago');

		const never = usageDisplay({ expiresAt: null, lastUsedAt: null }, NOW, formatRecent);
		expect(never.pill).toBeNull();
		expect(never.used).toBe('never');
	});

	it('labels today as earlier today, not 0d ago', () => {
		expect(usedDaysLabel(NOW - 60_000, NOW)).toBe('earlier today');
	});
});
