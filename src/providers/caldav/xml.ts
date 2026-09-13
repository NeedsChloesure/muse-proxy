/**
 * DAV XML: the three PROPFIND bodies we need, and a tolerant multistatus
 * parser.
 *
 * Parsing is deliberately forgiving. Real CalDAV servers disagree about
 * namespace prefixes, property ordering, and which optional properties they
 * bother to return, so nothing here throws on an unexpected shape — callers get
 * whatever was found and decide what counts as failure.
 */

import { XMLParser } from 'fast-xml-parser';

export const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;

export const PROPFIND_HOME_SETS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cr="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <c:calendar-home-set/>
    <cr:addressbook-home-set/>
  </d:prop>
</d:propfind>`;

/** Depth-1 listing of the collections inside a home set. */
export const PROPFIND_COLLECTIONS = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cr="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

const ARRAY_TAGS = new Set(['response', 'propstat', 'href', 'comp', 'principal']);

const parser = new XMLParser({
	removeNSPrefix: true,
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
	isArray: (name) => ARRAY_TAGS.has(name),
});

export interface DavProp {
	displayName: string | null;
	isCalendar: boolean;
	isAddressbook: boolean;
	components: string[];
	currentUserPrincipal: string | null;
	calendarHomeSet: string[];
	addressbookHomeSet: string[];
}

export interface DavResponse {
	href: string;
	prop: DavProp;
}

export function parseMultistatus(xml: string): DavResponse[] {
	let doc: unknown;
	try {
		doc = parser.parse(xml);
	} catch {
		return [];
	}

	const multistatus = pick(record(doc), 'multistatus');
	const responses = asArray(record(multistatus).response);

	const out: DavResponse[] = [];
	for (const entry of responses) {
		const response = record(entry);
		const href = firstText(response.href);
		if (!href) continue;

		// Merge every propstat, including ones marked 404: servers routinely
		// report "not found" per-property, and we take what we can get.
		const prop: Record<string, unknown> = {};
		for (const propstat of asArray(response.propstat)) {
			const inner = record(record(propstat).prop);
			Object.assign(prop, inner);
		}

		const resourceType = record(prop.resourcetype);
		out.push({
			href,
			prop: {
				displayName: text(prop.displayname) || null,
				isCalendar: pick(resourceType, 'calendar') !== undefined,
				isAddressbook: pick(resourceType, 'addressbook') !== undefined,
				components: asArray(record(pick(prop, 'supported-calendar-component-set')).comp)
					.map((comp) => attribute(comp, 'name'))
					.filter((name): name is string => Boolean(name)),
				currentUserPrincipal: firstText(record(pick(prop, 'current-user-principal')).href),
				calendarHomeSet: asArray(record(pick(prop, 'calendar-home-set')).href)
					.map(text)
					.filter(Boolean),
				addressbookHomeSet: asArray(record(pick(prop, 'addressbook-home-set')).href)
					.map(text)
					.filter(Boolean),
			},
		});
	}
	return out;
}

/** DAV-level error text, for a useful message when a PROPFIND fails. */
export function extractDavError(xml: string): string | null {
	try {
		const doc = record(parser.parse(xml));
		const error = record(pick(doc, 'error'));
		for (const key of Object.keys(error)) {
			if (key.startsWith('@_')) continue;
			return key;
		}
	} catch {
		return null;
	}
	return null;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function pick(obj: Record<string, unknown>, key: string): unknown {
	return obj[key];
}

function asArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	const inner = record(value)['#text'];
	return typeof inner === 'string' ? inner : '';
}

function firstText(value: unknown): string | null {
	for (const candidate of asArray(value)) {
		const found = text(candidate);
		if (found) return found;
	}
	return null;
}

function attribute(value: unknown, name: string): string | null {
	const attr = record(value)['@_' + name];
	return typeof attr === 'string' ? attr : null;
}
