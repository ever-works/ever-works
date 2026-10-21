import { describe, expect, it } from 'vitest';
import {
	FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC,
	FLEET_JOB_KINDS,
	FLEET_JOB_MAX_RESULT_BYTES,
	FLEET_MANAGEMENT_LANE_KINDS,
	fleetManagementLaneConsentFor,
	isFleetJobKind
} from '../fleet-jobs.types.js';
import {
	findModelListPriceEntry,
	priceModelTokensCents,
	type ModelListPriceListVersion
} from '../fleet-model-list-prices.types.js';
import {
	FLEET_USAGE_PAYER_NOTE,
	FLEET_USAGE_PERIODS,
	FLEET_USAGE_REPORT_MAX_ROWS,
	FLEET_USAGE_SCAN_CAPABILITY,
	fleetUsageHourStart,
	formatFleetUsageCents,
	formatFleetUsageTokens,
	isFleetUsageFolderBucket,
	isFleetUsagePeriodDays,
	maxFleetUsageTokens,
	normalizeFleetUsageReport,
	normalizeFleetUsageRow,
	normalizeFleetUsageScanPayload,
	parseFleetSessionUsage
} from '../fleet-usage.types.js';

const row = (overrides: Record<string, unknown> = {}) => ({
	provider: 'claude-code',
	providerSessionId: '3f2a9c1e-1b2c-4d5e-8f90-123456789abc',
	model: 'claude-sonnet-4-5-20250929',
	bucketStart: '2026-10-21T13:00:00.000Z',
	folderBucket: '/home/nina/code/api',
	tokens: { in: 120, out: 900, cacheRead: 40_000, cacheWrite: 2_000 },
	requests: 7,
	firstAt: '2026-10-21T13:02:11.000Z',
	lastAt: '2026-10-21T13:40:00.000Z',
	...overrides
});

describe('the usage-scan job kind (FL-20, CONTRACTS §12, R-34)', () => {
	it('is a job kind leased by the management lane under the usageScan consent', () => {
		expect(FLEET_JOB_KINDS).toContain('usage-scan');
		expect(isFleetJobKind('usage-scan')).toBe(true);
		expect(FLEET_MANAGEMENT_LANE_KINDS).toContain('usage-scan');
		expect(fleetManagementLaneConsentFor('usage-scan')).toBe('usageScan');
		expect(FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC['usage-scan']).toBe(7_200);
		expect(FLEET_USAGE_SCAN_CAPABILITY).toBe('usage-scan');
	});

	it('caps a report so it always fits the job result cap', () => {
		const rows = Array.from({ length: FLEET_USAGE_REPORT_MAX_ROWS }, (_, i) =>
			row({ providerSessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })
		);
		const bytes = JSON.stringify({ watermark: 1, rows, truncated: false, backlogPct: 0 }).length;
		expect(bytes).toBeLessThan(FLEET_JOB_MAX_RESULT_BYTES);
	});
});

describe('normalizeFleetUsageRow', () => {
	it('keeps exactly the allow-listed fields', () => {
		const normalized = normalizeFleetUsageRow({ ...row(), prompt: 'secret prompt', output: 'model output' });
		expect(normalized).toEqual(row());
		expect(JSON.stringify(normalized)).not.toContain('secret prompt');
	});

	it('refuses a row whose strings are not the shapes it allows', () => {
		expect(normalizeFleetUsageRow(row({ provider: 'gemini' }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ model: 'has spaces in it' }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ providerSessionId: 'a b' }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ folderBucket: 'relative/path' }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ folderBucket: 'other:XYZ' }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ bucketStart: '2026-10-21T13:30:00.000Z' }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ tokens: { in: -1 } }))).toBeNull();
		expect(normalizeFleetUsageRow(row({ requests: Number.NaN }))).toBeNull();
	});

	it('accepts an opaque folder bucket and a missing session id', () => {
		expect(normalizeFleetUsageRow(row({ folderBucket: 'other:0a1b2c3d', providerSessionId: null }))).toMatchObject({
			folderBucket: 'other:0a1b2c3d',
			providerSessionId: null
		});
		expect(isFleetUsageFolderBucket('C:\\Users\\nina\\code')).toBe(true);
		expect(isFleetUsageFolderBucket('/tmp/a\nb')).toBe(false);
	});
});

describe('normalizeFleetUsageReport', () => {
	it('drops bad rows and counts them', () => {
		const reading = normalizeFleetUsageReport({
			watermark: 12,
			rows: [row(), row({ provider: 'nope' })],
			truncated: true,
			backlogPct: 41.6
		});
		expect(reading?.droppedRows).toBe(1);
		expect(reading?.report).toMatchObject({ watermark: 12, truncated: true, backlogPct: 42 });
		expect(reading?.report.rows).toHaveLength(1);
	});

	it('refuses a report over the row cap and a non-report', () => {
		const rows = Array.from({ length: FLEET_USAGE_REPORT_MAX_ROWS + 1 }, () => row());
		expect(normalizeFleetUsageReport({ watermark: 1, rows })).toBeNull();
		expect(normalizeFleetUsageReport({ rows: [] })).toBeNull();
		expect(normalizeFleetUsageReport(null)).toBeNull();
	});

	it('reads the payload watermark, never trusting junk', () => {
		expect(normalizeFleetUsageScanPayload({ since: 40 })).toEqual({ since: 40 });
		expect(normalizeFleetUsageScanPayload({ since: -2 })).toEqual({ since: null });
		expect(normalizeFleetUsageScanPayload('x')).toEqual({ since: null });
	});
});

describe('the merge rule', () => {
	it('takes the field-wise maximum, so a re-sent row never double counts and a lost file never subtracts', () => {
		const stored = { in: 10, out: 20, cacheRead: 30, cacheWrite: 0 };
		expect(maxFleetUsageTokens(stored, stored)).toEqual(stored);
		expect(maxFleetUsageTokens(stored, { in: 5, out: 25, cacheRead: 0, cacheWrite: 1 })).toEqual({
			in: 10,
			out: 25,
			cacheRead: 30,
			cacheWrite: 1
		});
	});

	it('buckets by the hour', () => {
		expect(new Date(fleetUsageHourStart(Date.parse('2026-10-21T13:59:59.999Z'))).toISOString()).toBe(
			'2026-10-21T13:00:00.000Z'
		);
	});
});

describe('list-price matching and pricing (R-30)', () => {
	const version: ModelListPriceListVersion = {
		version: 1,
		effectiveFrom: '2026-10-21',
		entries: [
			{
				model: 'gpt-5',
				provider: 'codex',
				match: ['gpt-5'],
				perMillionUsd: { in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0 }
			},
			{
				model: 'gpt-5-codex',
				provider: 'codex',
				match: ['gpt-5-codex'],
				perMillionUsd: { in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0 }
			},
			{
				model: 'claude-sonnet-4-5',
				provider: 'claude-code',
				match: ['claude-sonnet-4-5'],
				perMillionUsd: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }
			}
		]
	};

	it('matches the longest family and never a guess', () => {
		expect(findModelListPriceEntry(version, 'claude-sonnet-4-5-20250929')?.model).toBe('claude-sonnet-4-5');
		expect(findModelListPriceEntry(version, 'gpt-5-codex')?.model).toBe('gpt-5-codex');
		expect(findModelListPriceEntry(version, 'gpt-5')?.model).toBe('gpt-5');
		expect(findModelListPriceEntry(version, 'gpt-50')).toBeNull();
		expect(findModelListPriceEntry(version, 'local-7b')).toBeNull();
	});

	it('prices the four classes separately', () => {
		const entry = findModelListPriceEntry(version, 'claude-sonnet-4-5')!;
		// 1M in = $3, 1M out = $15, 1M cache read = $0.30, 1M cache write = $3.75 → $22.05.
		expect(
			priceModelTokensCents({ in: 1_000_000, out: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, entry)
		).toBeCloseTo(2205, 6);
	});
});

describe('the surfaces', () => {
	it('carries the payer sentence verbatim', () => {
		expect(FLEET_USAGE_PAYER_NOTE).toBe(
			"List price — what this would cost on a pay-as-you-go key. The machine's own sign-in paid for it; Ever Works charged nothing."
		);
	});

	it('offers exactly the four periods', () => {
		expect([...FLEET_USAGE_PERIODS]).toEqual([1, 7, 30, 90]);
		expect(isFleetUsagePeriodDays(7)).toBe(true);
		expect(isFleetUsagePeriodDays(14)).toBe(false);
	});

	it('formats money and tokens', () => {
		expect(formatFleetUsageCents(42)).toBe('$0.42');
		expect(formatFleetUsageCents(0.4)).toBe('<$0.01');
		expect(formatFleetUsageCents(null)).toBeNull();
		expect(formatFleetUsageTokens(912)).toBe('912');
		expect(formatFleetUsageTokens(61_400)).toBe('61 k');
		expect(formatFleetUsageTokens(18_400_000)).toBe('18.4 M');
	});

	it('reads a stored session usage, dropping what it does not recognise', () => {
		const usage = parseFleetSessionUsage({
			byModel: {
				'claude-sonnet-4-5': { in: 1, out: 2, cacheRead: 3, cacheWrite: 4, requests: 2, costCents: 0.5 },
				'bad model': { in: 1 }
			},
			priceListVersion: 1,
			unknownModels: ['local-7b', 'not ok'],
			requests: 2,
			updatedAt: '2026-10-21T13:00:00.000Z'
		});
		expect(Object.keys(usage!.byModel)).toEqual(['claude-sonnet-4-5']);
		expect(usage!.unknownModels).toEqual(['local-7b']);
	});
});
