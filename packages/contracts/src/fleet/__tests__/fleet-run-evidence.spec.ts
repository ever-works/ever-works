import { describe, expect, it } from 'vitest';

import {
	FLEET_AGENT_TASK_TIMELINE_ARGS_MAX_CHARS,
	FLEET_AGENT_TASK_TIMELINE_MAX_STEPS,
	FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS,
	FLEET_AGENT_TASK_TIMELINE_TEXT_MAX_CHARS,
	FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES,
	FLEET_AGENT_TASK_TIMELINE_MAX_BYTES,
	FLEET_JOB_DEFAULT_RETENTION_DAYS,
	FLEET_JOB_MAX_RESULT_BYTES,
	FLEET_JOB_MAX_RETENTION_DAYS,
	FLEET_JOB_MIN_RETENTION_DAYS,
	normalizeFleetAgentTaskTimeline
} from '../fleet-jobs.types.js';

/**
 * Self-build slice AP — the run-evidence contract: the caps a node's step
 * records and transcript are held to, the retention window for a job's
 * bodies, and the coercing reader the reconciler trusts a node's timeline
 * through.
 */
describe('fleet run evidence (self-build slice AP)', () => {
	it('keeps the timeline and the transcript well inside the job result cap together', () => {
		// The result also carries setup / check tails, the git verdict and the
		// question; the node sheds those first, but the evidence must never be
		// able to fill the cap on its own.
		expect(FLEET_AGENT_TASK_TIMELINE_MAX_BYTES + FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES).toBeLessThan(
			FLEET_JOB_MAX_RESULT_BYTES / 2
		);
		expect(FLEET_AGENT_TASK_TIMELINE_MAX_STEPS).toBe(200);
	});

	it('pins the retention window at 30 days by default, inside its bounds', () => {
		expect(FLEET_JOB_DEFAULT_RETENTION_DAYS).toBe(30);
		expect(FLEET_JOB_MIN_RETENTION_DAYS).toBeLessThanOrEqual(FLEET_JOB_DEFAULT_RETENTION_DAYS);
		expect(FLEET_JOB_MAX_RETENTION_DAYS).toBeGreaterThanOrEqual(FLEET_JOB_DEFAULT_RETENTION_DAYS);
	});

	describe('normalizeFleetAgentTaskTimeline', () => {
		it('passes well-formed steps through', () => {
			const { steps, dropped } = normalizeFleetAgentTaskTimeline([
				{ kind: 'assistant-message', atMs: 1200, text: 'Reading the failing test first.' },
				{
					kind: 'tool-call',
					atMs: 1500,
					toolName: 'Bash',
					callId: 'toolu_1',
					argsSummary: 'command=pnpm test',
					status: 'error',
					durationMs: 3200
				}
			]);
			expect(dropped).toBe(0);
			expect(steps).toEqual([
				{ kind: 'assistant-message', atMs: 1200, text: 'Reading the failing test first.' },
				{
					kind: 'tool-call',
					atMs: 1500,
					toolName: 'Bash',
					callId: 'toolu_1',
					argsSummary: 'command=pnpm test',
					status: 'error',
					durationMs: 3200
				}
			]);
		});

		it('COUNTS what it cannot read instead of dropping it silently', () => {
			const { steps, dropped } = normalizeFleetAgentTaskTimeline(
				[
					null,
					'a string',
					{ kind: 'thinking', text: 'x' },
					{ kind: 'tool-call' },
					{ kind: 'assistant-message', text: '   ' },
					{ kind: 'tool-call', toolName: 'Read' }
				],
				3
			);
			expect(steps).toHaveLength(1);
			// three reported by the node + five unreadable here
			expect(dropped).toBe(8);
		});

		it('coerces an unknown status to unknown and nonsense times to null', () => {
			const { steps } = normalizeFleetAgentTaskTimeline([
				{ kind: 'tool-call', toolName: 'Edit', status: 'exploded', atMs: -5, durationMs: Number.NaN }
			]);
			expect(steps[0]).toEqual({
				kind: 'tool-call',
				atMs: null,
				toolName: 'Edit',
				status: 'unknown',
				durationMs: null
			});
		});

		it('strips control characters (Postgres rejects a NUL in text) and re-caps every field', () => {
			const { steps } = normalizeFleetAgentTaskTimeline([
				{ kind: 'assistant-message', atMs: 0, text: `a\u0000b\u001b[31mc${'x'.repeat(5000)}` },
				{
					kind: 'tool-call',
					atMs: 0,
					toolName: 'T'.repeat(500),
					callId: 'c'.repeat(500),
					argsSummary: 'y'.repeat(5000)
				}
			]);
			const [message, call] = steps;
			expect(message.text?.startsWith('abc')).toBe(true);
			expect(message.text).not.toContain('\u0000');
			expect(Array.from(message.text ?? '')).toHaveLength(FLEET_AGENT_TASK_TIMELINE_TEXT_MAX_CHARS);
			expect(message.truncated).toBe(true);
			expect(Array.from(call.toolName ?? '')).toHaveLength(FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS);
			expect(Array.from(call.callId ?? '').length).toBeLessThanOrEqual(FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS);
			expect(Array.from(call.argsSummary ?? '')).toHaveLength(FLEET_AGENT_TASK_TIMELINE_ARGS_MAX_CHARS);
			expect(call.truncated).toBe(true);
		});

		it('caps the step count and counts the overflow', () => {
			const many = Array.from({ length: FLEET_AGENT_TASK_TIMELINE_MAX_STEPS + 7 }, (_, i) => ({
				kind: 'tool-call',
				atMs: i,
				toolName: 'Read',
				status: 'ok'
			}));
			const { steps, dropped } = normalizeFleetAgentTaskTimeline(many);
			expect(steps).toHaveLength(FLEET_AGENT_TASK_TIMELINE_MAX_STEPS);
			expect(dropped).toBe(7);
		});

		it('reads a missing or non-array timeline as empty, never throwing', () => {
			expect(normalizeFleetAgentTaskTimeline(undefined)).toEqual({ steps: [], dropped: 0 });
			expect(normalizeFleetAgentTaskTimeline({ steps: [] }, 'many')).toEqual({ steps: [], dropped: 0 });
		});
	});
});
