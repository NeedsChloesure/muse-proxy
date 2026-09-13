/**
 * REPORT bodies name their own targets.
 *
 * Every other DAV method addresses exactly what its URL addresses, which is why
 * the gateway can authorize the request path and then forward blindly. REPORT
 * breaks that: a `calendar-multiget` or `addressbook-multiget` carries a list of
 * `DAV:href`s and the server resolves each of them independently. A key granted
 * read on one calendar could therefore name an object in a calendar it may not
 * read, because the upstream credential — the user's own — is allowed to fetch
 * it. Authorizing only the request path would leave the per-collection scoping
 * that this gateway exists to enforce bypassable by anyone who can write XML.
 *
 * So a REPORT body is inspected before it is forwarded: every href is resolved
 * into gateway coordinates and authorized individually. Three deliberate
 * choices, all of them failing closed:
 *
 *   - A body that cannot be parsed is REFUSED rather than forwarded. Two XML
 *     parsers are in play here (ours and the server's), and a parser
 *     differential is precisely how such a check is defeated.
 *   - An href whose text cannot be read — a CDATA section, an unexpanded entity
 *     — is refused for the same reason: "we saw a target but could not name it"
 *     must never be treated as "there was no target".
 *   - An href that cannot be resolved into this connection is refused rather
 *     than skipped, so an absolute URL pointing at another host is a named
 *     error and not a silent hole.
 *
 * One differential is worth naming because it is not hypothetical: this parser
 * expands an entity declared in an internal DTD subset — so `<D:href>&e;</D:href>`
 * arrives as the real path and is authorized for real — but an entity declared
 * as EXTERNAL is left as the literal text `&e;`. A server that resolves external
 * entities would act on a target we had authorized as a meaningless relative
 * path. Ampersands cannot appear in a CalDAV href (objects are addressed by
 * server-generated names), so a reference containing one is refused outright.
 *
 * Hrefs are accepted in every form real clients and servers emit:
 * gateway-absolute (`/api/agent/caldav/<id>/calendars/alice/work/x.ics`),
 * gateway-relative, upstream-absolute with the base path
 * (`/dav.php/calendars/alice/work/x.ics`), absolute URL on the connection's
 * origin, or a path relative to the collection being reported on (as GET
 * bodies, and sabre/dav's own responses, commonly are).
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
	removeNSPrefix: true,
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
});

/**
 * Every href in a REPORT body, in document order, or null when the body could
 * not be parsed or an href could not be read. Null is a refusal, never a skip.
 */
export function extractReportHrefs(xml: string): string[] | null {
	let doc: unknown;
	try {
		doc = parser.parse(xml);
	} catch {
		return null;
	}
	if (doc === null || typeof doc !== 'object') return null;

	const found: string[] = [];
	return collect(doc, found) ? found : null;
}

/** Returns false when an href was seen but its text could not be read. */
function collect(node: unknown, found: string[]): boolean {
	if (Array.isArray(node)) {
		for (const item of node) {
			if (!collect(item, found)) return false;
		}
		return true;
	}
	if (node === null || typeof node !== 'object') return true;

	for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
		// Namespace prefixes are stripped by the parser, so DAV's `D:href` from
		// any server arrives here as plain `href`. Matching on the local name
		// means extraction is a superset of what any server will honour, which is
		// the safe direction.
		if (name === 'href') {
			if (!collectText(value, found)) return false;
		} else if (!collect(value, found)) {
			return false;
		}
	}
	return true;
}

/**
 * Returns false when nothing readable was found, rather than reporting success
 * with no value: an href we cannot read is not an href that is not there.
 */
function collectText(value: unknown, found: string[]): boolean {
	if (Array.isArray(value)) {
		let ok = false;
		for (const item of value) {
			if (collectText(item, found)) ok = true;
		}
		return ok;
	}
	if (typeof value === 'string') {
		if (!value.trim()) return false;
		found.push(value.trim());
		return true;
	}
	if (value !== null && typeof value === 'object') {
		const inner = (value as Record<string, unknown>)['#text'];
		if (typeof inner === 'string' && inner.trim()) {
			found.push(inner.trim());
			return true;
		}
	}
	return false;
}

/**
 * Characters that make a reference either non-plain or ambiguous.
 *
 * `&` is the important one (see the module comment); the rest cannot appear in
 * a path a server issued to us, and a backslash is a liability on servers that
 * treat it as a separator while we do not.
 */
const UNSAFE_REFERENCE = /[&<>\\\u0000-\u001f\u007f]/;

export interface ReferenceContext {
	/** The connection's base URL, already validated against the SSRF policy. */
	base: URL;
	connectionId: string;
	/**
	 * The gateway path the request addresses, used to resolve a relative
	 * reference. Only meaningful for REPORT hrefs; a Destination header is
	 * absolute by definition.
	 */
	relativeTo: string;
}

/**
 * Translate one upstream reference into a gateway path — no leading slash, the
 * form resource keys use — or null when it cannot be expressed as one.
 *
 * Null is not a denial in itself — it is "outside this connection", which the
 * caller turns into a named error. Guessing here would mean authorizing one
 * thing while the server acted on another.
 */
export function toGatewayPath(reference: string, context: ReferenceContext): string | null {
	const raw = reference.trim();
	if (!raw) return null;
	if (UNSAFE_REFERENCE.test(raw)) return null;

	const gatewayPrefix = `/api/agent/caldav/${encodeURIComponent(context.connectionId)}/`;

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return null;
		}
		if (url.pathname.startsWith(gatewayPrefix)) return url.pathname.slice(gatewayPrefix.length);
		// A URL on another origin is another connection's business entirely.
		if (url.origin !== context.base.origin) return null;
		if (!url.pathname.startsWith(context.base.pathname)) return null;
		return url.pathname.slice(context.base.pathname.length);
	}

	if (raw.startsWith('/')) {
		if (raw.startsWith(gatewayPrefix)) return raw.slice(gatewayPrefix.length);
		if (raw.startsWith('/api/agent/')) return null; // another connection's namespace
		// Upstream-absolute, spelling out the base path the connection already
		// carries. Servers report hrefs this way, so accepting it is required.
		if (raw.startsWith(context.base.pathname)) return raw.slice(context.base.pathname.length);
		// Otherwise it is already in gateway coordinates.
		return raw.replace(/^\/+/, '');
	}

	// Relative to the collection being reported on.
	if (!context.relativeTo) return null;
	try {
		const directory = context.relativeTo.endsWith('/') ? context.relativeTo : context.relativeTo.replace(/[^/]*$/, '');
		return new URL(raw, `https://relative.invalid${directory.startsWith('/') ? '' : '/'}${directory}`).pathname.slice(1);
	} catch {
		return null;
	}
}
