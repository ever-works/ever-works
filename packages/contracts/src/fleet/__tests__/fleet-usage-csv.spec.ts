import { describe, expect, it } from 'vitest';
import {
	FLEET_USAGE_PAYER_NOTE,
	fleetUsageCsv,
	fleetUsageCsvFilename,
	type FleetUsageView
} from '../fleet-usage.types.js';

/** FL-20 P3 — the Usage tab's CSV export (and `ever-works fleet usage --csv`). */

const zero = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

function view(overrides: Partial<FleetUsageView> = {}): FleetUsageView {
	return {
		days: 30,
		from: '2026-09-27T12:00:00.000Z',
		to: '2026-10-27T12:00:00.000Z',
		nodeId: null,
		model: null,
		totals: {
			costCents: 4120,
			tokens: { in: 1000, out: 200, cacheRead: 30, cacheWrite: 4 },
			requests: 12,
			topModel: 'claude-sonnet-4-5'
		},
		byModel: [
			{
				model: 'claude-sonnet-4-5',
				provider: 'claude-code',
				tokens: { in: 1000, out: 200, cacheRead: 30, cacheWrite: 4 },
				requests: 10,
				costCents: 4120
			},
			{ model: 'local-7b', provider: 'codex', tokens: zero, requests: 2, costCents: null }
		],
		byNode: [
			{
				nodeId: 'n1',
				name: '=HYPERLINK("x")',
				scan: { state: 'on', online: true, lastScanAt: null, backlogPct: 0, hint: null },
				costCents: 4120,
				tokens: zero,
				requests: 12
			},
			{
				nodeId: 'n2',
				name: 'laptop, the old one',
				scan: { state: 'off', online: true, lastScanAt: null, backlogPct: null, hint: 'h' },
				costCents: null,
				tokens: zero,
				requests: 0
			}
		],
		busiestCheckouts: [
			{ nodeId: 'n1', nodeName: 'build-01', path: null, checkoutId: null, costCents: 100, tokens: zero }
		],
		sessions: {
			agents: [{ agentId: 'a1', name: 'Nina', sessions: 3, costCents: 900 }],
			owner: { sessions: 0, costCents: null },
			other: null
		},
		unknownModels: { models: ['local-7b'], requests: 2 },
		excluded: { nodes: 0, otherHidden: false },
		catchingUp: null,
		priceList: { version: 1, effectiveFrom: '2026-10-26', versionsUsed: [1] },
		note: FLEET_USAGE_PAYER_NOTE,
		...overrides
	};
}

describe('fleetUsageCsv', () => {
	const lines = fleetUsageCsv(view()).trimEnd().split('\r\n');

	it('has one header, one row per model / computer / checkout / Agent, a total and the payer sentence last', () => {
		expect(lines[0]).toBe(
			'section,name,computer,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,list_price_usd'
		);
		expect(lines[1]).toBe('model,claude-sonnet-4-5,,10,1000,200,30,4,41.20');
		// An unknown model is tokens only: an empty price, never 0.
		expect(lines[2]).toBe('model,local-7b,,2,0,0,0,0,');
		expect(lines.find((line) => line.startsWith('checkout,'))).toBe(
			'checkout,other folders,build-01,,0,0,0,0,1.00'
		);
		expect(lines.find((line) => line.startsWith('agent,'))).toBe('agent,Nina,,,,,,,9.00');
		expect(lines.at(-2)).toBe('total,last 30 day(s),,12,1000,200,30,4,41.20');
		expect(lines.at(-1)).toContain('note,');
		expect(lines.at(-1)).toContain('Ever Works charged nothing.');
	});

	it('quotes commas and never lets a spreadsheet read a name as a formula', () => {
		expect(lines).toContain(`computer,"'=HYPERLINK(""x"")","'=HYPERLINK(""x"")",12,0,0,0,0,41.20`);
		// The scan is off: no price, whatever the row holds.
		expect(lines).toContain('computer,"laptop, the old one","laptop, the old one",0,0,0,0,0,');
	});

	it('names the file after the period, the filter and the day', () => {
		expect(fleetUsageCsvFilename(view())).toBe('fleet-usage-30d-2026-10-27.csv');
		expect(
			fleetUsageCsvFilename(
				view({ days: 7, nodeId: '11111111-2222-4333-8444-555555555555', model: 'gpt-5/codex' })
			)
		).toBe('fleet-usage-7d-node-11111111-gpt-5_codex-2026-10-27.csv');
	});
});
