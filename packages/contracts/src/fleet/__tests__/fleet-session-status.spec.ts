import { describe, expect, it } from 'vitest';

import {
	FLEET_SESSION_BOUNDARY_MS,
	FLEET_SESSION_IDLE_AFTER_MS,
	FLEET_SESSION_PRECEDENCE_GUARD_MS,
	fleetSessionAttentionKey,
	fleetSessionBoardColumn,
	fleetSessionStatusSource,
	initialFleetSessionStatus,
	isFleetSessionAttentionUnread,
	mergeFleetSessionEvidence,
	parseFleetSessionAnswerParams,
	parseFleetSessionAttentionKey,
	parseFleetSessionAttentionMessage,
	parseFleetSessionStatusMessage,
	type FleetSessionEvidence,
	type FleetSessionMergeContext,
	type FleetSessionStatusSnapshot
} from '../fleet-session-status.types.js';

const SESSION = 'f3c1a0de-1111-4222-8333-444455556666';
const claude = { sessionId: SESSION, provider: 'claude-code' as const };
const shell = { sessionId: SESSION, provider: 'shell' as const };

function run(
	events: Array<Partial<FleetSessionEvidence> & Pick<FleetSessionEvidence, 'event'>>,
	ctx: FleetSessionMergeContext = claude,
	start: FleetSessionStatusSnapshot = initialFleetSessionStatus(0)
) {
	let snapshot = start;
	const results = [];
	for (const event of events) {
		const result = mergeFleetSessionEvidence(
			snapshot,
			{ source: 'hook', at: 0, ...event } as FleetSessionEvidence,
			ctx
		);
		results.push(result);
		snapshot = result.next;
	}
	return { snapshot, results };
}

describe('mergeFleetSessionEvidence — hooks first (FR-16)', () => {
	it('prompt → working; permission → needs_you with a key; stop → done · success', () => {
		const { snapshot, results } = run([
			{ event: 'session-start', at: 1_000 },
			{ event: 'prompt', at: 10_000, userLine: 'run the migration tests' },
			{ event: 'permission', at: 20_000, prompt: 'Allow Bash(pnpm db:migrate)?', tool: 'Bash', promptId: 'tu_1' },
			{ event: 'answered', at: 25_000 },
			{ event: 'stop', at: 60_000, agentLine: 'All 42 tests pass.' }
		]);
		expect(results[1].next.state).toBe('working');
		expect(results[2].next.state).toBe('needs_you');
		expect(results[2].next.attention?.key).toBe(fleetSessionAttentionKey(SESSION, 'permission', 'tu_1'));
		expect(results[2].attentionChanged).toBe(true);
		expect(results[3].next.state).toBe('working');
		expect(results[3].next.attention).toBeNull();
		expect(snapshot.state).toBe('done');
		expect(snapshot.outcome).toBe('success');
		expect(snapshot.userLine).toBe('run the migration tests');
		expect(snapshot.agentLine).toBe('All 42 tests pass.');
		expect(results[4].finished).toBe(true);
		expect(snapshot.attention?.reason).toBe('finished');
	});

	it('a stop inside the boundary window after a start, with no prompt, is not news (U12)', () => {
		const { snapshot, results } = run([
			{ event: 'session-start', at: 1_000 },
			{ event: 'stop', at: 1_000 + FLEET_SESSION_BOUNDARY_MS - 1 }
		]);
		expect(snapshot.state).toBe('done');
		expect(results[1].finished).toBe(false);
		expect(snapshot.attention).toBeNull();
	});

	it('a second stop for the same turn mints nothing new', () => {
		const { results } = run([
			{ event: 'prompt', at: 1_000 },
			{ event: 'stop', at: 2_000 },
			{ event: 'stop', at: 2_500 }
		]);
		expect(results[1].finished).toBe(true);
		expect(results[2].finished).toBe(false);
		expect(results[2].attentionChanged).toBe(false);
	});

	it('a confirming permission notification keeps the edge', () => {
		const { results } = run([
			{ event: 'prompt', at: 1_000 },
			{ event: 'permission', at: 2_000, prompt: 'Allow Bash(ls)?', promptId: 'a' },
			{ event: 'permission', at: 2_100, prompt: 'Claude needs your permission', confirmOnly: true }
		]);
		expect(results[2].attentionChanged).toBe(false);
		expect(results[2].next.attention?.key).toBe(results[1].next.attention?.key);
	});

	it('a richer report updates the open edge in place', () => {
		const { results } = run([
			{ event: 'prompt', at: 1_000 },
			{ event: 'permission', at: 2_000, prompt: 'Allow Bash(ls)?' },
			{
				event: 'permission',
				at: 2_100,
				prompt: 'Allow Bash(ls)?',
				options: [
					{ id: 'allow', label: 'Allow', primary: true },
					{ id: 'deny', label: 'Deny', deny: true }
				]
			}
		]);
		expect(results[2].next.attention?.key).toBe(results[1].next.attention?.key);
		expect(results[2].next.attention?.options).toHaveLength(2);
	});
});

describe('mergeFleetSessionEvidence — precedence and silence (FR-13, FR-14)', () => {
	it('a rule never overrides a hook state newer than 10 s', () => {
		const { results } = run([
			{ event: 'prompt', at: 1_000 },
			{ event: 'permission', at: 2_000, source: 'rules', prompt: 'Allow?' }
		]);
		expect(results[1].guarded).toBe(true);
		expect(results[1].next.state).toBe('working');
	});

	it('the guard expires after 10 s', () => {
		const { results } = run([
			{ event: 'prompt', at: 1_000 },
			{ event: 'permission', at: 1_000 + FLEET_SESSION_PRECEDENCE_GUARD_MS, source: 'rules', prompt: 'Allow?' }
		]);
		expect(results[1].next.state).toBe('needs_you');
	});

	it('30 min of silence → idle; one output byte → working; never done by silence', () => {
		const { results } = run([
			{ event: 'prompt', at: 0 },
			{ event: 'silence', source: 'exit', at: FLEET_SESSION_IDLE_AFTER_MS - 1 },
			{ event: 'silence', source: 'exit', at: FLEET_SESSION_IDLE_AFTER_MS },
			{ event: 'activity', source: 'exit', at: FLEET_SESSION_IDLE_AFTER_MS + 1 }
		]);
		expect(results[1].next.state).toBe('working');
		expect(results[2].next.state).toBe('idle');
		expect(results[3].next.state).toBe('working');
		for (const result of results) expect(result.next.state).not.toBe('done');
	});

	it('Ctrl-C in a running turn → done · interrupted, no news (U15)', () => {
		const { snapshot, results } = run([
			{ event: 'prompt', at: 0 },
			{ event: 'interrupt', source: 'exit', at: 100 }
		]);
		expect(snapshot.state).toBe('done');
		expect(snapshot.outcome).toBe('interrupted');
		expect(results[1].finished).toBe(false);
	});

	it('no rule can raise done', () => {
		const { snapshot } = run(
			[
				{ event: 'working', source: 'rules', at: 0 },
				{ event: 'idle-weak', source: 'rules', at: 100 }
			],
			claude
		);
		expect(snapshot.state).not.toBe('done');
	});
});

describe('mergeFleetSessionEvidence — a shell (FR-19, U20)', () => {
	it('is only ever working, idle or ended', () => {
		const { results } = run(
			[
				{ event: 'prompt', at: 0 },
				{ event: 'permission', at: 1, prompt: 'x' },
				{ event: 'stop', at: 2 },
				{ event: 'silence', source: 'exit', at: FLEET_SESSION_IDLE_AFTER_MS + 10 },
				{ event: 'activity', source: 'exit', at: FLEET_SESSION_IDLE_AFTER_MS + 20 }
			],
			shell
		);
		for (const result of results) expect(['working', 'idle']).toContain(result.next.state);
		expect(results[3].next.state).toBe('idle');
		expect(results[4].next.state).toBe('working');
	});
});

describe('attention keys and unread (CONTRACTS §5.2)', () => {
	it('round-trips', () => {
		const key = fleetSessionAttentionKey(SESSION, 'question', 'tool_use:9');
		expect(parseFleetSessionAttentionKey(key)).toEqual({
			sessionId: SESSION,
			reason: 'question',
			promptId: 'tool_use9'
		});
		expect(parseFleetSessionAttentionKey('fleet-session:x/y:question:1')).toBeNull();
	});

	it('acknowledgedAt < raisedAt is unread', () => {
		const base = {
			key: 'k',
			reason: 'finished' as const,
			prompt: '',
			options: [],
			raisedAt: '2026-10-21T10:00:00Z'
		};
		expect(isFleetSessionAttentionUnread({ ...base, acknowledgedAt: null })).toBe(true);
		expect(isFleetSessionAttentionUnread({ ...base, acknowledgedAt: '2026-10-21T09:59:00Z' })).toBe(true);
		expect(isFleetSessionAttentionUnread({ ...base, acknowledgedAt: '2026-10-21T10:01:00Z' })).toBe(false);
	});
});

describe('status source (FR-11)', () => {
	it('labels hooks, partial, screen, shell', () => {
		expect(fleetSessionStatusSource('shell', null)).toBe('shell');
		expect(fleetSessionStatusSource('claude-code', null)).toBe('screen');
		expect(
			fleetSessionStatusSource('claude-code', {
				provider: 'claude-code',
				injected: true,
				events: ['UserPromptSubmit', 'PermissionRequest', 'Stop']
			})
		).toBe('hooks');
		expect(
			fleetSessionStatusSource('claude-code', { provider: 'claude-code', injected: true, events: ['Stop'] })
		).toBe('partial');
		expect(
			fleetSessionStatusSource('codex', { provider: 'codex', injected: true, events: ['agent-turn-complete'] })
		).toBe('partial');
	});
});

describe('link messages (CONTRACTS §3.3)', () => {
	it('parse a status report and refuse ended or malformed ones', () => {
		const message = {
			type: 'session.status',
			sessionId: SESSION,
			seq: 1_760_000_000_000,
			state: 'needs_you',
			outcome: null,
			stateChangedAt: '2026-10-21T10:00:00.000Z',
			lastEvidence: { source: 'hook', at: '2026-10-21T10:00:00.000Z', detail: { event: 'permission', seq: 1 } },
			boundaryUntil: null
		};
		expect(parseFleetSessionStatusMessage(message)?.state).toBe('needs_you');
		expect(parseFleetSessionStatusMessage({ ...message, state: 'ended' })).toBeNull();
		expect(parseFleetSessionStatusMessage({ ...message, seq: -1 })).toBeNull();
	});

	it('an attention must name its own session', () => {
		const attention = {
			key: fleetSessionAttentionKey('other-session', 'permission', '1'),
			reason: 'permission',
			prompt: 'Allow?',
			options: [],
			raisedAt: '2026-10-21T10:00:00.000Z',
			acknowledgedAt: null
		};
		expect(
			parseFleetSessionAttentionMessage({ type: 'session.attention', sessionId: SESSION, seq: 1, attention })
		).toBeNull();
		expect(
			parseFleetSessionAttentionMessage({
				type: 'session.attention',
				sessionId: SESSION,
				seq: 1,
				attention: null
			})?.attention
		).toBeNull();
	});

	it('an answer names exactly one of an option and a text', () => {
		const key = fleetSessionAttentionKey(SESSION, 'question', '1');
		expect(parseFleetSessionAnswerParams({ key, answer: { optionId: '1' } })).not.toBeNull();
		expect(parseFleetSessionAnswerParams({ key, answer: { text: 'eu-west' } })).not.toBeNull();
		expect(parseFleetSessionAnswerParams({ key, answer: { optionId: '1', text: 'x' } })).toBeNull();
		expect(parseFleetSessionAnswerParams({ key, answer: {} })).toBeNull();
	});
});

describe('board columns (FR-41, FR-42)', () => {
	const now = Date.parse('2026-10-21T12:00:00Z');
	it('done leaves the board after 24 h; ended is list-only', () => {
		expect(fleetSessionBoardColumn({ state: 'done', stateChangedAt: '2026-10-21T11:00:00Z' }, now)).toBe('done');
		expect(fleetSessionBoardColumn({ state: 'done', stateChangedAt: '2026-10-20T11:00:00Z' }, now)).toBeNull();
		expect(fleetSessionBoardColumn({ state: 'ended' }, now)).toBeNull();
		expect(fleetSessionBoardColumn({ state: 'starting' }, now)).toBe('working');
	});
});
