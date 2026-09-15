import { describe, expect, it } from 'vitest';

import { lowerComputerQuality } from '../computer-frame.codec.js';
import {
	COMPUTER_CLOSE_REASONS,
	COMPUTER_CONTROL_RELEASE_REASONS,
	COMPUTER_QUALITIES,
	COMPUTER_QUALITY_PRESETS
} from '../computer-frame.types.js';
import {
	COMPUTER_CHANNELS,
	COMPUTER_CONTROL_POLICIES,
	COMPUTER_SESSION_OPEN_STATUSES,
	COMPUTER_SESSION_STATUSES,
	COMPUTER_UNWATCHABLE_REASONS,
	isComputerChannel,
	isComputerCloseReason,
	isComputerControlReleaseReason,
	isComputerControlPolicy,
	isComputerQuality,
	isComputerSessionStatus,
	isComputerUnwatchableReason
} from '../computer-session.types.js';

describe('COMPUTER_QUALITY_PRESETS', () => {
	it('pins the three named tiers to their exact parameters', () => {
		expect(COMPUTER_QUALITY_PRESETS).toEqual({
			sharp: { width: 1280, maxFps: 8, keyframeMs: 5000, q: 70 },
			smooth: { width: 960, maxFps: 15, keyframeMs: 5000, q: 55 },
			steady: { width: 800, maxFps: 2, keyframeMs: 2000, q: 45 }
		});
		expect(Object.isFrozen(COMPUTER_QUALITY_PRESETS)).toBe(true);
		expect(Object.isFrozen(COMPUTER_QUALITY_PRESETS.sharp)).toBe(true);
	});

	it('orders the tiers sharpest first and covers each with a preset', () => {
		expect(COMPUTER_QUALITIES).toEqual(['sharp', 'smooth', 'steady']);
		expect(Object.keys(COMPUTER_QUALITY_PRESETS).sort()).toEqual([...COMPUTER_QUALITIES].sort());
	});

	it('degrades one tier at a time and holds at the floor', () => {
		expect(lowerComputerQuality('sharp')).toBe('smooth');
		expect(lowerComputerQuality('smooth')).toBe('steady');
		expect(lowerComputerQuality('steady')).toBe('steady');
	});
});

describe('session vocabularies', () => {
	it('keeps every string union beside a guard that agrees with it', () => {
		const pairs: Array<[readonly string[], (value: unknown) => boolean]> = [
			[COMPUTER_SESSION_STATUSES, isComputerSessionStatus],
			[COMPUTER_CHANNELS, isComputerChannel],
			[COMPUTER_QUALITIES, isComputerQuality],
			[COMPUTER_UNWATCHABLE_REASONS, isComputerUnwatchableReason],
			[COMPUTER_CONTROL_POLICIES, isComputerControlPolicy],
			[COMPUTER_CLOSE_REASONS, isComputerCloseReason],
			[COMPUTER_CONTROL_RELEASE_REASONS, isComputerControlReleaseReason]
		];
		for (const [list, guard] of pairs) {
			for (const value of list) expect(guard(value)).toBe(true);
			expect(guard('nope')).toBe(false);
			expect(guard(undefined)).toBe(false);
		}
	});

	it('lists the nine unwatchable reasons in the order they are checked', () => {
		expect(COMPUTER_UNWATCHABLE_REASONS).toEqual([
			'cluster',
			'disabled',
			'paused',
			'draining',
			'offline',
			'not-attended',
			'no-browser',
			'no-display',
			'no-terminal'
		]);
	});

	it('counts only unfinished sessions against the caps', () => {
		expect(COMPUTER_SESSION_OPEN_STATUSES).toEqual(['requested', 'live', 'stalled']);
		expect(COMPUTER_SESSION_OPEN_STATUSES).not.toContain('ended');
	});
});
