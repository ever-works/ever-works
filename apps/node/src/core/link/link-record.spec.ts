import { describe, expect, it } from 'vitest';
import {
	describeConsents,
	describeLinkRecord,
	nodeLinkRecordPath,
	parseNodeLinkRecord,
	readNodeLinkRecord,
	toNodeLinkRecord,
	writeNodeLinkRecord
} from './link-record';

const consents = { work: true, attend: false, manage: true, usageScan: false };

describe('node link record', () => {
	it('round-trips through the file beside the config', async () => {
		const files = new Map<string, string>();
		const fs = {
			readFile: async (path: string) => files.get(path) ?? null,
			writeFile: async (path: string, content: string) => void files.set(path, content),
			mkdir: async () => undefined,
			dirname: (path: string) => path.replace(/\/[^/]*$/, '')
		};
		const record = toNodeLinkRecord(
			consents,
			{
				phase: 'connected',
				detail: null,
				linkGeneration: 8,
				connectedSince: Date.parse('2026-10-18T09:40:00.000Z'),
				lastDisconnectAt: null,
				bytesIn: 10,
				bytesOut: 20,
				openChannels: 1,
				paused: false,
				nextAttemptInMs: null
			},
			Date.parse('2026-10-18T09:41:00.000Z')
		);
		await writeNodeLinkRecord(fs, '/cfg/node-config.json', record);
		expect(files.has(nodeLinkRecordPath('/cfg/node-config.json'))).toBe(true);
		expect(await readNodeLinkRecord(fs, '/cfg/node-config.json')).toEqual(record);
		// Bytes and channel counts are runtime facts, not part of the record.
		expect(record).not.toHaveProperty('bytesIn');
	});

	it('reads a hand-edited, truncated or foreign file as no record', () => {
		expect(parseNodeLinkRecord(null)).toBeNull();
		expect(parseNodeLinkRecord('{')).toBeNull();
		expect(parseNodeLinkRecord(JSON.stringify({ version: 2 }))).toBeNull();
		expect(
			parseNodeLinkRecord(
				JSON.stringify({ version: 1, recordedAt: '2026-10-18T09:41:00.000Z', consents, phase: 'exploded' })
			)
		).toBeNull();
		expect(
			parseNodeLinkRecord(JSON.stringify({ version: 1, recordedAt: 'yesterday', consents, phase: 'connected' }))
		).toBeNull();
	});

	it('describes the consents and each link phase for `status`', () => {
		expect(describeConsents(consents)).toBe('work · manage');
		expect(describeConsents({ work: false, attend: false, manage: false, usageScan: false })).toBe(
			'none (enrolled only — reports health)'
		);
		const base = {
			version: 1 as const,
			recordedAt: '2026-10-18T09:41:00.000Z',
			consents,
			detail: null,
			linkGeneration: null,
			connectedSince: null
		};
		const now = Date.parse('2026-10-18T09:41:30.000Z');
		expect(describeLinkRecord(null, now)).toMatch(/unknown/);
		expect(describeLinkRecord({ ...base, phase: 'reconnecting' }, now)).toBe(
			'reconnecting… — as of 2026-10-18T09:41:00.000Z'
		);
		expect(
			describeLinkRecord(
				{ ...base, phase: 'refused', detail: 'refused by the platform: flag off' },
				now + 3_600_000
			)
		).toBe('refused by the platform: flag off — as of 2026-10-18T09:41:00.000Z (3630s ago)');
	});
});
