/**
 * Mail runtime configuration.
 *
 * Vars arrive as strings even when declared as numbers in wrangler.jsonc, so
 * everything is clamped here. The names are the ones Maildrop used, which keeps
 * the migration and the operating notes unambiguous.
 */

const MB = 1024 * 1024;

/** Hard ceiling on a single KV value. */
export const KV_VALUE_LIMIT = 25 * MB;
/** Cloudflare rejects inbound messages larger than this before the Worker sees them. */
export const INBOUND_PLATFORM_LIMIT = 25 * MB;

export interface MailConfig {
	defaultDomain: string;
	maxMessageBytes: number;
	inlineAttachmentMax: number;
	rawInlineMax: number;
	maxBodyBytes: number;
	retentionDays: number;
}

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function mailConfigFrom(env: Env): MailConfig {
	return {
		defaultDomain: (env.DEFAULT_DOMAIN ?? '').trim().toLowerCase(),
		// Keep under the platform ceiling even if configured higher.
		maxMessageBytes: intFrom(env.MAX_MESSAGE_BYTES, 10 * MB, 1024, INBOUND_PLATFORM_LIMIT),
		// Prefer D1 for attachments up to 1 MiB; KV writes are more valuable. D1
		// rows and values top out at 2 MB, so leave room for row metadata.
		inlineAttachmentMax: intFrom(env.INLINE_ATTACHMENT_MAX, 1 * MB, 0, 1_900_000),
		rawInlineMax: intFrom(env.RAW_INLINE_MAX, 128 * 1024, 0, 1_600_000),
		maxBodyBytes: intFrom(env.MAX_BODY_BYTES, 512 * 1024, 1024, 1_700_000),
		retentionDays: intFrom(env.RETENTION_DAYS, 0, 0, 3650),
	};
}
