import { describe, expect, it } from 'vitest';

import {
	COMPUTER_AUTO_REFRESH_AFTER_MS,
	COMPUTER_CAPTURE_RESTART_AFTER_FAILURES,
	COMPUTER_DEAD_AFTER_MS,
	COMPUTER_DEGRADE_ACK_MS,
	COMPUTER_DEGRADE_BACKLOG_FRAMES,
	COMPUTER_DEGRADE_WINDOW_MS,
	COMPUTER_RECOVER_WINDOW_MS,
	COMPUTER_STALL_AFTER_MS,
	computerStallStateForAge,
	isOverLinkLimits,
	shouldDegrade,
	shouldRecover
} from '../computer-link.policy.js';
import * as contracts from '../../index.js';

describe('computer link thresholds', () => {
	it('pins every number the capture pump, the browser and the session rules share', () => {
		expect(COMPUTER_DEGRADE_BACKLOG_FRAMES).toBe(3);
		expect(COMPUTER_DEGRADE_ACK_MS).toBe(1500);
		expect(COMPUTER_DEGRADE_WINDOW_MS).toBe(5000);
		expect(COMPUTER_RECOVER_WINDOW_MS).toBe(30_000);
		expect(COMPUTER_STALL_AFTER_MS).toBe(6000);
		expect(COMPUTER_AUTO_REFRESH_AFTER_MS).toBe(20_000);
		expect(COMPUTER_DEAD_AFTER_MS).toBe(45_000);
		expect(COMPUTER_CAPTURE_RESTART_AFTER_FAILURES).toBe(3);
	});

	it('is reachable from the package root, so no reader re-declares a threshold', () => {
		expect(contracts.computerStallStateForAge).toBe(computerStallStateForAge);
		expect(contracts.shouldDegrade).toBe(shouldDegrade);
		expect(contracts.COMPUTER_DEAD_AFTER_MS).toBe(COMPUTER_DEAD_AFTER_MS);
	});
});

describe('isOverLinkLimits', () => {
	it('is over only strictly above the backlog or acknowledgement limit', () => {
		expect(isOverLinkLimits({ backlog: COMPUTER_DEGRADE_BACKLOG_FRAMES, ackMs: COMPUTER_DEGRADE_ACK_MS })).toBe(
			false
		);
		expect(isOverLinkLimits({ backlog: COMPUTER_DEGRADE_BACKLOG_FRAMES + 1, ackMs: 0 })).toBe(true);
		expect(isOverLinkLimits({ backlog: 0, ackMs: COMPUTER_DEGRADE_ACK_MS + 1 })).toBe(true);
	});
});

describe('shouldDegrade / shouldRecover', () => {
	const over = { backlog: COMPUTER_DEGRADE_BACKLOG_FRAMES + 1, ackMs: 0 };
	const within = { backlog: 0, ackMs: 0 };

	it('drops a tier only after the whole degrade window over a limit', () => {
		expect(shouldDegrade(over, COMPUTER_DEGRADE_WINDOW_MS - 1)).toBe(false);
		expect(shouldDegrade(over, COMPUTER_DEGRADE_WINDOW_MS)).toBe(true);
		expect(shouldDegrade(within, COMPUTER_DEGRADE_WINDOW_MS * 10)).toBe(false);
	});

	it('returns to the chosen tier only after the whole recover window within limits', () => {
		expect(shouldRecover(within, COMPUTER_RECOVER_WINDOW_MS - 1)).toBe(false);
		expect(shouldRecover(within, COMPUTER_RECOVER_WINDOW_MS)).toBe(true);
		expect(shouldRecover(over, COMPUTER_RECOVER_WINDOW_MS * 10)).toBe(false);
	});
});

describe('computerStallStateForAge', () => {
	it('walks ok → stalled → auto-refresh → dead at the inclusive boundaries, ±1 ms', () => {
		expect(computerStallStateForAge(COMPUTER_STALL_AFTER_MS - 1)).toBe('ok');
		expect(computerStallStateForAge(COMPUTER_STALL_AFTER_MS)).toBe('stalled');
		expect(computerStallStateForAge(COMPUTER_AUTO_REFRESH_AFTER_MS - 1)).toBe('stalled');
		expect(computerStallStateForAge(COMPUTER_AUTO_REFRESH_AFTER_MS)).toBe('auto-refresh');
		expect(computerStallStateForAge(COMPUTER_DEAD_AFTER_MS - 1)).toBe('auto-refresh');
		expect(computerStallStateForAge(COMPUTER_DEAD_AFTER_MS)).toBe('dead');
	});

	it('never calls a stream that has not flowed yet, or a clock that ran backwards, stalled', () => {
		expect(computerStallStateForAge(null)).toBe('ok');
		expect(computerStallStateForAge(undefined)).toBe('ok');
		expect(computerStallStateForAge(-5)).toBe('ok');
		expect(computerStallStateForAge(Number.NaN)).toBe('ok');
		expect(computerStallStateForAge(Number.POSITIVE_INFINITY)).toBe('ok');
	});
});
