import { describe, expect, it } from 'vitest';
import {
	ATTENDED_EMPTY_POLLS_BEFORE_SLOW,
	ATTENDED_FAST_POLL_MS,
	ATTENDED_RECENT_SESSION_MS,
	ATTENDED_SLOW_POLL_MS,
	AttendedPollCadence,
	clampAttendedPollMs
} from './attended-cadence';

describe('clampAttendedPollMs', () => {
	it('defaults to 2 s and clamps into 500–10000 ms', () => {
		expect(clampAttendedPollMs(undefined)).toBe(ATTENDED_FAST_POLL_MS);
		expect(clampAttendedPollMs(Number.NaN)).toBe(ATTENDED_FAST_POLL_MS);
		expect(clampAttendedPollMs(100)).toBe(500);
		expect(clampAttendedPollMs(60_000)).toBe(10_000);
		expect(clampAttendedPollMs(1234.4)).toBe(1234);
	});
});

describe('AttendedPollCadence', () => {
	function cadence(start = 1_000_000) {
		let now = start;
		const subject = new AttendedPollCadence({ now: () => now });
		return { subject, advance: (ms: number) => (now += ms) };
	}

	it('polls fast until ten consecutive empty polls with no recent view, then backs off to 15 s', () => {
		const { subject } = cadence();
		for (let i = 0; i < ATTENDED_EMPTY_POLLS_BEFORE_SLOW - 1; i += 1) subject.recordPoll(0);
		expect(subject.nextIdleDelayMs()).toBe(ATTENDED_FAST_POLL_MS);
		subject.recordPoll(0);
		expect(subject.nextIdleDelayMs()).toBe(ATTENDED_SLOW_POLL_MS);
	});

	it('stays fast after ten empty polls while a view was claimed in the previous ten minutes', () => {
		const { subject, advance } = cadence();
		subject.recordPoll(1);
		for (let i = 0; i < ATTENDED_EMPTY_POLLS_BEFORE_SLOW; i += 1) subject.recordPoll(0);
		advance(ATTENDED_RECENT_SESSION_MS - 1);
		expect(subject.nextIdleDelayMs()).toBe(ATTENDED_FAST_POLL_MS);
		advance(1);
		expect(subject.nextIdleDelayMs()).toBe(ATTENDED_SLOW_POLL_MS);
	});

	it('returns to fast the moment a heartbeat reports a pending view, and ignores an empty hint', () => {
		const { subject } = cadence();
		for (let i = 0; i < ATTENDED_EMPTY_POLLS_BEFORE_SLOW; i += 1) subject.recordPoll(0);
		expect(subject.isSlow()).toBe(true);
		expect(subject.notePendingSessions([])).toBe(false);
		expect(subject.notePendingSessions(undefined)).toBe(false);
		expect(subject.isSlow()).toBe(true);
		expect(subject.notePendingSessions(['session-1'])).toBe(true);
		expect(subject.nextIdleDelayMs()).toBe(ATTENDED_FAST_POLL_MS);
	});
});
