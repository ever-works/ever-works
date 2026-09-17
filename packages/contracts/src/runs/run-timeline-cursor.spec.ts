import { describe, expect, it } from 'vitest';
import {
	AGENT_RUN_TIMELINE_CURSOR_PATTERN,
	AGENT_RUN_TIMELINE_ROW_ID_PATTERN,
	AGENT_RUN_TIMELINE_TIE_BREAK_PATTERN,
	isAgentRunTimelineInsertionOrderTieBreak
} from './run-timeline-cursor.js';

/** `<epochMillis>_<tieBreak>`, as the API mints it. */
const cursor = (tieBreak: string) => `1758128000000_${tieBreak}`;

const ROW_ID = '00000000-0000-4000-8000-00000000cc62';

describe('AGENT_RUN_TIMELINE_CURSOR_PATTERN', () => {
	it('accepts the uuid row id a cursor minted before the integer form carries', () => {
		expect(AGENT_RUN_TIMELINE_CURSOR_PATTERN.test(cursor(ROW_ID))).toBe(true);
		expect(AGENT_RUN_TIMELINE_CURSOR_PATTERN.test(cursor(ROW_ID.toUpperCase()))).toBe(true);
	});

	it('accepts the integer insertion-order tie-break', () => {
		for (const tieBreak of ['1', '42', '9223372036854775807']) {
			expect(AGENT_RUN_TIMELINE_CURSOR_PATTERN.test(cursor(tieBreak))).toBe(true);
		}
	});

	it('rejects a tie-break of a third shape, which no store can compare', () => {
		for (const tieBreak of [
			// 36 hex-ish characters, but not a uuid: the shape a looser
			// pattern admits and Postgres then rejects at bind time.
			'000000000000000000000000000000000000',
			'------------------------------------',
			'00000000-0000-4000-8000-00000000cc6',
			'00000000_0000_4000_8000_00000000cc62',
			// 20 digits: past what an integer key can name.
			'12345678901234567890',
			'log-42',
			''
		]) {
			expect(AGENT_RUN_TIMELINE_CURSOR_PATTERN.test(cursor(tieBreak))).toBe(false);
		}
	});

	it('rejects a malformed instant half', () => {
		for (const token of ['_42', 'x_42', '1758128000000', '1758128000000_42_1', ' 1758128000000_42']) {
			expect(AGENT_RUN_TIMELINE_CURSOR_PATTERN.test(token)).toBe(false);
		}
	});

	it('admits exactly the two tie-break shapes the halves describe', () => {
		// The whole-token pattern is spelled out, so pin it against the
		// halves rather than trusting two literals to stay in step.
		for (const tieBreak of [ROW_ID, '42', 'log-42', '']) {
			const half =
				AGENT_RUN_TIMELINE_TIE_BREAK_PATTERN.test(tieBreak) || AGENT_RUN_TIMELINE_ROW_ID_PATTERN.test(tieBreak);
			expect(AGENT_RUN_TIMELINE_CURSOR_PATTERN.test(cursor(tieBreak))).toBe(half);
		}
	});
});

describe('isAgentRunTimelineInsertionOrderTieBreak', () => {
	it('is true for the integer key only the sqlite family can compare', () => {
		expect(isAgentRunTimelineInsertionOrderTieBreak('42')).toBe(true);
		expect(isAgentRunTimelineInsertionOrderTieBreak('0')).toBe(true);
	});

	it('is false for a uuid row id, so the two stores never trade positions', () => {
		expect(isAgentRunTimelineInsertionOrderTieBreak(ROW_ID)).toBe(false);
		expect(isAgentRunTimelineInsertionOrderTieBreak('')).toBe(false);
		expect(isAgentRunTimelineInsertionOrderTieBreak('4 2')).toBe(false);
	});
});
