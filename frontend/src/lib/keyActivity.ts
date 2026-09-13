/**
 * Key-usage flagging — the dashboard's answer to "is this agent doing anything?"
 *
 * The activity log was removed because a per-request table is unbounded storage
 * on a Free-plan deployment. What remains is one timestamp per key,
 * `last_used_at`, updated only by authorized requests. It cannot say what an
 * agent did, but it answers the question a human actually has.
 *
 * Day resolution is deliberate. "3 hours ago" invites you to reconstruct a
 * timeline from a value that is a coarse UPDATE on a shared row; "used 0 days
 * ago" says only what is truly known.
 *
 * One property of the data drives everything here: an expired key can never
 * update its timestamp again (the 401 path never reaches the touch), so a dead
 * key's `last_used_at` is frozen at its last successful use. Revocation is
 * deletion — an expunged key simply leaves the list — so expiry is the only
 * dead state, which makes the flagging rule a single comparison:
 *
 *   active  — not expired
 *   unused  — live but never used; the normal state of an unneeded key
 *   suspect — expired, and last used within the window: the key was in active
 *             use when it expired, and the whole event is recent. Its agent is
 *             plausibly still running — and now hitting walls.
 *   stale   — expired, and quiet for longer than the window: old news,
 *             whatever the relationship between its last use and its death.
 */

/** How far back, in days, a use by a non-live key counts as recent. */
export const SUSPECT_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/** Midnight (UTC) of the day a timestamp falls in. */
export function dayFloor(timestamp: number): number {
	return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

/**
 * Whole days between the day `lastUsedAt` happened and the day `now` is in:
 * 0 means "earlier today", 4 means "four days ago".
 */
export function usedDaysAgo(lastUsedAt: number, now: number): number {
	const days = (dayFloor(now) - dayFloor(lastUsedAt)) / DAY_MS;
	return Math.max(0, days);
}

export interface KeyUsageInput {
	expiresAt: number | null;
	lastUsedAt: number | null;
}

export type KeyUsageState = 'active' | 'unused' | 'stale' | 'suspect';

export function keyUsageState(key: KeyUsageInput, now: number): KeyUsageState {
	if (key.lastUsedAt === null) return 'unused';

	const notLive = key.expiresAt !== null && key.expiresAt <= now;
	if (!notLive) return 'active';

	return usedDaysAgo(key.lastUsedAt, now) < SUSPECT_WINDOW_DAYS ? 'suspect' : 'stale';
}

/** Whole-day wording for a dead key's frozen timestamp. */
export function usedDaysLabel(lastUsedAt: number, now: number): string {
	const days = usedDaysAgo(lastUsedAt, now);
	return days === 0 ? 'earlier today' : `${days}d ago`;
}

/** How the console renders each state. Kept here so pages cannot drift apart. */
export interface UsageDisplay {
	/** The extra pill a state earns, if any; every state has Last-used text. */
	pill: { text: string; tone: 'ok' | 'bad' | 'warn' | 'muted' } | null;
	/** Last-used cell text. */
	used: string;
}

export function usageDisplay(key: KeyUsageInput, now: number, formatRecent: (timestamp: number) => string): UsageDisplay {
	const state = keyUsageState(key, now);
	const used = key.lastUsedAt === null ? 'never' : state === 'active' ? formatRecent(key.lastUsedAt) : usedDaysLabel(key.lastUsedAt, now);

	if (state === 'suspect') {
		return { pill: { text: 'recently active', tone: 'warn' }, used };
	}
	if (state === 'active') {
		return { pill: null, used };
	}
	return { pill: null, used };
}
