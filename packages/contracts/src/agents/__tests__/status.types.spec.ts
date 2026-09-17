import { describe, expect, it } from 'vitest';
import {
	AGENT_STATUS_BATCH_MAX,
	AGENT_STATUS_DOT,
	AGENT_STATUS_POLL_INTERVAL_MS,
	AGENT_STATUS_REASONS,
	type AgentStatusReasonCode
} from '../status.types.js';
import { AGENT_HALT_NOTE_MAX, AGENT_HALT_REASONS, AGENT_RESUME_PROMOTION_BUDGET } from '../identity.types.js';

/**
 * These constants are a wire surface: the API derives the reason, the web
 * renders one dot per member, and both import the SAME tuple. A member
 * added without a dot would render colour-free; a renamed member would
 * silently blank every card mid-deploy.
 */
describe('agent status contracts', () => {
	it('states ten reasons, in precedence-friendly order', () => {
		expect(AGENT_STATUS_REASONS).toEqual([
			'working',
			'idle',
			'waitingOnYou',
			'pausedByYou',
			'blockedOnCredential',
			'stoppedByFailures',
			'stoppedAtACap',
			'stoppedByThePlatform',
			'notStarted',
			'archived'
		]);
	});

	it('gives every reason exactly one dot appearance', () => {
		for (const reason of AGENT_STATUS_REASONS) {
			expect(AGENT_STATUS_DOT[reason]).toBeDefined();
		}
		expect(Object.keys(AGENT_STATUS_DOT).sort()).toEqual([...AGENT_STATUS_REASONS].sort());
	});

	it('paints the two stop-the-world reasons hardest', () => {
		const dot = (reason: AgentStatusReasonCode) => AGENT_STATUS_DOT[reason];
		expect(dot('working')).toBe('green');
		expect(dot('stoppedByFailures')).toBe('red');
		expect(dot('pausedByYou')).toBe('amber');
		expect(dot('notStarted')).toBe('greyOutline');
		expect(dot('archived')).toBe('grey');
	});

	it('pins the polling cadence and the batch ceiling', () => {
		expect(AGENT_STATUS_POLL_INTERVAL_MS).toBe(10_000);
		expect(AGENT_STATUS_BATCH_MAX).toBe(100);
	});

	it('pins the halt reasons, the note ceiling and the resume budget', () => {
		expect(AGENT_HALT_REASONS).toEqual(['user', 'credential', 'failures', 'cap', 'platform']);
		expect(AGENT_HALT_NOTE_MAX).toBe(200);
		expect(AGENT_RESUME_PROMOTION_BUDGET).toBe(50);
	});
});
