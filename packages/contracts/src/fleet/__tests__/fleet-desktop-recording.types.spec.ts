import { describe, expect, it } from 'vitest';
import {
	decodeDesktopRecordingChunk,
	encodeDesktopRecordingChunk,
	fleetDesktopRecordingRetentionDays,
	isFleetDesktopRecordingStopReason,
	FLEET_DESKTOP_RECORDING_MAX_BYTES,
	FLEET_DESKTOP_RECORDING_MAX_MS,
	FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT
} from '../fleet-desktop-recording.types.js';

/** Desktop view & control (FL-07 P2.C, FR-50, FR-52) — the recording chunk container, caps and retention. */

const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

describe('the EWR1 chunk container', () => {
	it('round-trips keyframes and tiles in time order', () => {
		const bytes = encodeDesktopRecordingChunk([
			{ tMs: 0, kind: 20, payload: jpeg },
			{ tMs: 250, kind: 23, payload: new Uint8Array([9, 9]) },
			{ tMs: 1_000, kind: 20, payload: jpeg }
		]);
		expect(bytes).not.toBeNull();
		const entries = decodeDesktopRecordingChunk(bytes!);
		expect(entries?.map((entry) => [entry.tMs, entry.kind, entry.payload.byteLength])).toEqual([
			[0, 20, 7],
			[250, 23, 2],
			[1_000, 20, 7]
		]);
	});

	it('refuses what is not exactly a chunk, and never throws', () => {
		expect(decodeDesktopRecordingChunk(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		const bytes = encodeDesktopRecordingChunk([{ tMs: 5, kind: 20, payload: jpeg }])!;
		expect(decodeDesktopRecordingChunk(bytes.subarray(0, bytes.byteLength - 1))).toBeNull();
		const backwards = encodeDesktopRecordingChunk([
			{ tMs: 10, kind: 20, payload: jpeg },
			{ tMs: 5, kind: 20, payload: jpeg }
		])!;
		expect(decodeDesktopRecordingChunk(backwards)).toBeNull();
		expect(encodeDesktopRecordingChunk([{ tMs: 1, kind: 21 as never, payload: jpeg }])).toBeNull();
		expect(encodeDesktopRecordingChunk([{ tMs: -1, kind: 20, payload: jpeg }])).toBeNull();
		expect(decodeDesktopRecordingChunk(encodeDesktopRecordingChunk([])!)).toEqual([]);
	});
});

describe('caps and retention', () => {
	it('caps a recording at 200 MB and 4 hours (FR-50)', () => {
		expect(FLEET_DESKTOP_RECORDING_MAX_BYTES).toBe(200 * 1024 * 1024);
		expect(FLEET_DESKTOP_RECORDING_MAX_MS).toBe(4 * 3_600_000);
	});

	it('keeps 14 days by default and clamps a computer’s setting to 1–90 (FR-52)', () => {
		expect(fleetDesktopRecordingRetentionDays(undefined)).toBe(FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT);
		expect(fleetDesktopRecordingRetentionDays(0)).toBe(1);
		expect(fleetDesktopRecordingRetentionDays(365)).toBe(90);
		expect(fleetDesktopRecordingRetentionDays(30.4)).toBe(30);
		expect(fleetDesktopRecordingRetentionDays('7')).toBe(14);
	});

	it('names why a recording stopped', () => {
		expect(isFleetDesktopRecordingStopReason('size-cap')).toBe(true);
		expect(isFleetDesktopRecordingStopReason('crashed')).toBe(false);
	});
});
