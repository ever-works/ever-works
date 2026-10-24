import { describe, expect, it } from 'vitest';

import {
	FLEET_CLIP_MAX_BYTES,
	fleetClipByteLength,
	isFleetClipText,
	parseFleetClipOpenParams
} from '../fleet-clip.types.js';

describe('FL-11 paste — contracts', () => {
	it('caps a paste at 256 KiB measured in UTF-8', () => {
		expect(FLEET_CLIP_MAX_BYTES).toBe(262144);
		expect(fleetClipByteLength('é')).toBe(2);
		expect(isFleetClipText('a'.repeat(FLEET_CLIP_MAX_BYTES))).toBe(true);
		expect(isFleetClipText('a'.repeat(FLEET_CLIP_MAX_BYTES + 1))).toBe(false);
		// 131 073 two-byte characters are 262 146 bytes — over, though fewer characters than the cap.
		expect(isFleetClipText('é'.repeat(131_073))).toBe(false);
	});

	it('refuses empty text and NUL', () => {
		expect(isFleetClipText('')).toBe(false);
		expect(isFleetClipText('a\0b')).toBe(false);
		expect(isFleetClipText(42)).toBe(false);
	});

	it('opens with a view id only (R-27)', () => {
		expect(parseFleetClipOpenParams({ viewId: 'view_1' })).toEqual({ viewId: 'view_1' });
		expect(parseFleetClipOpenParams({ viewId: '../x' })).toBeNull();
		expect(parseFleetClipOpenParams({ sessionId: 'abc' })).toBeNull();
	});
});
