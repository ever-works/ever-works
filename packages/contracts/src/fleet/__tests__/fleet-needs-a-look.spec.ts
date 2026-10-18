import { describe, expect, it } from 'vitest';

import {
	NEEDS_A_LOOK_KINDS,
	NEEDS_A_LOOK_PARTIAL_HEADER,
	NEEDS_A_LOOK_MAX_TITLE_LENGTH,
	NEEDS_A_LOOK_SEVERITIES,
	isNeedsALookKind,
	isNeedsALookRoute,
	normalizeNeedsALookItem,
	sortNeedsALook
} from '../fleet-needs-a-look.types.js';
import type { NeedsALookItem } from '../fleet-needs-a-look.types.js';

/**
 * Fleet hub (FL-01) — "needs a look": the one shape every producer emits
 * (CONTRACTS §4.6) and the order the hub renders it in (FR-5).
 */

function item(over: Partial<NeedsALookItem> = {}): NeedsALookItem {
	return {
		id: 'disk-low:n1',
		nodeId: 'n1',
		severity: 'warn',
		kind: 'disk-low',
		title: 'Disk is 94% full',
		detail: '6 GB left, the node stops at 5 GB',
		since: '2026-10-18T09:00:00.000Z',
		...over
	};
}

describe('kinds and severities', () => {
	it('is the closed set of CONTRACTS §4.6 (revision 4: thirteen kinds)', () => {
		expect(NEEDS_A_LOOK_KINDS).toEqual([
			'disk-low',
			'node-throttled',
			'node-quarantined',
			'node-upgrade-required',
			'runner-stopped',
			'job-unassignable',
			'session-needs-you',
			'session-unconfirmed',
			'service-failed',
			'schedule-failed',
			'cloud-idle',
			'helper-untrusted',
			'consent-missing'
		]);
		expect(isNeedsALookKind('disk-low')).toBe(true);
		expect(isNeedsALookKind('disk-full')).toBe(false);
	});

	it('names the partial-answer header the API sets and the web reads', () => {
		expect(NEEDS_A_LOOK_PARTIAL_HEADER).toBe('X-Fleet-Partial');
	});

	it('orders severities most urgent first', () => {
		expect(NEEDS_A_LOOK_SEVERITIES).toEqual(['critical', 'warn', 'info']);
	});
});

describe('sortNeedsALook', () => {
	it('sorts critical, warn, info, then the longest-standing first (ACC-FL01-03)', () => {
		const sorted = sortNeedsALook([
			item({ id: 'a', severity: 'info', since: '2026-10-18T08:00:00.000Z' }),
			item({ id: 'b', severity: 'warn', since: '2026-10-18T09:30:00.000Z' }),
			item({ id: 'c', severity: 'critical', since: '2026-10-18T09:45:00.000Z' }),
			item({ id: 'd', severity: 'warn', since: '2026-10-18T09:00:00.000Z' })
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(['c', 'd', 'b', 'a']);
	});

	it('breaks a tie by id so two reads render the same order', () => {
		const sorted = sortNeedsALook([item({ id: 'z' }), item({ id: 'm' })]);
		expect(sorted.map((entry) => entry.id)).toEqual(['m', 'z']);
	});

	it('does not mutate its input', () => {
		const input = [item({ id: 'b', severity: 'info' }), item({ id: 'a', severity: 'critical' })];
		sortNeedsALook(input);
		expect(input.map((entry) => entry.id)).toEqual(['b', 'a']);
	});
});

describe('isNeedsALookRoute', () => {
	it('accepts an app path and refuses anything that leaves the app', () => {
		expect(isNeedsALookRoute('/fleet/computers/n1?tab=overview')).toBe(true);
		expect(isNeedsALookRoute('https://example.com')).toBe(false);
		expect(isNeedsALookRoute('//example.com/x')).toBe(false);
		expect(isNeedsALookRoute('/\\example.com')).toBe(false);
		expect(isNeedsALookRoute('fleet')).toBe(false);
	});

	it('refuses whitespace and control characters URL parsing would strip into //host', () => {
		for (const sneaky of [
			'/\t/evil.example',
			'/\n/evil.example',
			'/\r/evil.example',
			'/ /x',
			'/\u0000/x',
			'/\u007f/x'
		]) {
			expect(isNeedsALookRoute(sneaky), JSON.stringify(sneaky)).toBe(false);
		}
		expect(isNeedsALookRoute('/fleet/computers/n1?tab=logs#top')).toBe(true);
	});
});

describe('normalizeNeedsALookItem', () => {
	it('keeps a well-formed item and normalises its instant', () => {
		const normalized = normalizeNeedsALookItem({
			...item(),
			since: '2026-10-18T09:00:00Z',
			action: { label: 'Open', route: '/fleet/computers/n1' }
		});
		expect(normalized).toEqual({
			...item(),
			action: { label: 'Open', route: '/fleet/computers/n1' }
		});
	});

	it('drops an item with an unknown kind or severity, or without the required fields', () => {
		expect(normalizeNeedsALookItem({ ...item(), kind: 'disk-full' })).toBeNull();
		expect(normalizeNeedsALookItem({ ...item(), severity: 'urgent' })).toBeNull();
		expect(normalizeNeedsALookItem({ ...item(), title: '  ' })).toBeNull();
		expect(normalizeNeedsALookItem({ ...item(), since: 'yesterday' })).toBeNull();
		expect(normalizeNeedsALookItem(null)).toBeNull();
	});

	it('drops an action that would navigate off the app, keeping the row', () => {
		const normalized = normalizeNeedsALookItem({
			...item(),
			action: { label: 'Open', route: 'https://example.com' }
		});
		expect(normalized).not.toBeNull();
		expect(normalized?.action).toBeUndefined();
	});

	it('accepts a named command action', () => {
		const normalized = normalizeNeedsALookItem({
			...item({ kind: 'node-throttled' }),
			action: { label: 'Clear limit now', command: 'clear-model-throttle' }
		});
		expect(normalized?.action).toEqual({ label: 'Clear limit now', command: 'clear-model-throttle' });
		expect(
			normalizeNeedsALookItem({ ...item(), action: { label: 'x', command: 'rm -rf /' } })?.action
		).toBeUndefined();
	});

	it('clips an oversized title', () => {
		const normalized = normalizeNeedsALookItem({ ...item(), title: 'x'.repeat(1_000) });
		expect(normalized?.title.length).toBe(NEEDS_A_LOOK_MAX_TITLE_LENGTH);
	});

	it('keeps exactly the CONTRACTS §4.6 fields and drops anything else a producer adds', () => {
		const normalized = normalizeNeedsALookItem({ ...item(), nodeName: 'build-01', params: { percent: 94 } });
		expect(normalized).toEqual(item());
		expect(Object.keys(normalized ?? {}).sort()).toEqual(
			['detail', 'id', 'kind', 'nodeId', 'severity', 'since', 'title'].sort()
		);
	});
});
