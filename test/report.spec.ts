import { describe, expect, it } from 'vitest';

import { extractReportHrefs, toGatewayPath } from '../src/providers/caldav/report';

/**
 * REPORT is the one DAV method whose targets are not in its URL, so both halves
 * of the check are pinned here: reading the hrefs out of a body, and translating
 * each into gateway coordinates. The integration behaviour — a refused href
 * never reaching upstream — lives in test/caldav.spec.ts.
 */

const BASE = new URL('https://dav.example.com/dav.php/');

/** A connection mounted under a base path, reporting on one collection. */
const CONTEXT = {
	base: BASE,
	connectionId: 'conn-1',
	relativeTo: '/calendars/alice/work/',
};

describe('extractReportHrefs', () => {
	it('finds every href of a calendar-multiget', () => {
		const body = `<?xml version="1.0"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <D:href>/dav.php/calendars/alice/work/a.ics</D:href>
  <D:href>/dav.php/calendars/alice/work/b.ics</D:href>
</C:calendar-multiget>`;

		expect(extractReportHrefs(body)).toEqual([
			'/dav.php/calendars/alice/work/a.ics',
			'/dav.php/calendars/alice/work/b.ics',
		]);
	});

	it('matches the local name whatever the prefix, including a default namespace', () => {
		const body =
			'<calendar-multiget xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
			'<href>/a.ics</href><c:filter/></calendar-multiget>';
		expect(extractReportHrefs(body)).toEqual(['/a.ics']);
	});

	it('returns nothing for a REPORT that names no targets', () => {
		const body =
			'<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
			'<D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>';
		expect(extractReportHrefs(body)).toEqual([]);
	});

	it('trims surrounding whitespace', () => {
		expect(extractReportHrefs('<m:href xmlns:m="DAV:">\n  /a.ics\n</m:href>')).toEqual(['/a.ics']);
	});

	it('refuses a body that is not XML at all', () => {
		expect(extractReportHrefs('')).toBeNull();
		expect(extractReportHrefs('not xml at all')).toBeNull();
	});

	it('sees the real target of an entity declared in an internal DTD subset', () => {
		// The parser expands it, so the href is authorized as the path it is.
		const body =
			'<!DOCTYPE multiget [<!ENTITY e "/calendars/alice/private/x.ics">]>' +
			'<D:multiget xmlns:D="DAV:"><D:href>&e;</D:href></D:multiget>';
		expect(extractReportHrefs(body)).toEqual(['/calendars/alice/private/x.ics']);
	});

	it('never reports an unreadable href as "no targets"', () => {
		// Either the text is read, or the body is refused. What must not happen
		// is an empty list: a target the server would act on but we could not
		// name is exactly the bypass this check exists for.
		expect(extractReportHrefs('<href><![CDATA[hidden]]></href>')).not.toEqual([]);
		expect(extractReportHrefs('<href>&unexpandable;</href>')).not.toEqual([]);
	});

	it('does not treat an href inside a comment as a target', () => {
		expect(extractReportHrefs('<q><!-- <href>/a.ics</href> --></q>')).toEqual([]);
	});
});

describe('toGatewayPath', () => {
	const target = (reference: string, context = CONTEXT) => toGatewayPath(reference, context);

	it('accepts gateway coordinates', () => {
		expect(target('/api/agent/caldav/conn-1/calendars/alice/work/x.ics')).toBe('calendars/alice/work/x.ics');
		expect(target('/calendars/alice/work/x.ics')).toBe('calendars/alice/work/x.ics');
	});

	it('accepts the upstream-absolute form a server reports, base path included', () => {
		expect(target('/dav.php/calendars/alice/work/x.ics')).toBe('calendars/alice/work/x.ics');
		expect(target('https://dav.example.com/dav.php/calendars/alice/work/x.ics')).toBe('calendars/alice/work/x.ics');
	});

	it('resolves a reference relative to the collection being reported on', () => {
		expect(target('x.ics')).toBe('calendars/alice/work/x.ics');
		expect(target('../private/s.ics')).toBe('calendars/alice/private/s.ics');
	});

	it('refuses an href on another origin', () => {
		expect(target('https://evil.example.com/calendars/alice/work/x.ics')).toBeNull();
	});

	it('refuses another connection', () => {
		expect(target('/api/agent/caldav/conn-2/calendars/alice/work/x.ics')).toBeNull();
	});

	it('refuses a URL outside the connection base path', () => {
		expect(target('https://dav.example.com/other/x.ics')).toBeNull();
	});

	it('refuses a relative reference when there is nothing to resolve against', () => {
		// A Destination header is absolute by definition.
		expect(target('x.ics', { ...CONTEXT, relativeTo: '' })).toBeNull();
	});

	it('refuses an empty reference', () => {
		expect(target('')).toBeNull();
	});

	it('refuses an entity reference left unexpanded by the XML parser', () => {
		// An external-DTD entity comes back as literal text. Resolving it as a
		// relative path would authorize one resource while a server that expands
		// entities acted on another.
		expect(target('&e;')).toBeNull();
		expect(target('/calendars/alice/work/x.ics&e;')).toBeNull();
	});

	it('refuses a reference carrying markup or control characters', () => {
		expect(target('/calendars/alice/work/<x>.ics')).toBeNull();
		expect(target('/calendars/alice/work/x\u0000.ics')).toBeNull();
	});
});
