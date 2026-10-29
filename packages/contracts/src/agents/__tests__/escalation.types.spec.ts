import { describe, expect, it } from 'vitest';
import { AGENT_ESCALATION_REASON_CODES } from '../escalation.types.js';

/**
 * Escalation reason codes are persisted (`agent_escalations.reasonCode`), so the list is a
 * compatibility surface: members are only ever appended (APW-08 T7 adds `delivery-failed`).
 */
describe('AGENT_ESCALATION_REASON_CODES', () => {
	it("appends APW-08's 'delivery-failed' last and leaves every earlier entry unchanged", () => {
		expect(AGENT_ESCALATION_REASON_CODES).toEqual([
			'gate-exhausted',
			'gate-precheck-red',
			'judge-escalated',
			'guardrail-refusal',
			'budget-stop',
			'merge-refused',
			'awaiting-input',
			'run-parked',
			'queued-too-long',
			'loop-detected',
			'delivery-failed'
		]);
	});

	it('every code fits the varchar(32) column', () => {
		for (const code of AGENT_ESCALATION_REASON_CODES) expect(code.length).toBeLessThanOrEqual(32);
	});
});
