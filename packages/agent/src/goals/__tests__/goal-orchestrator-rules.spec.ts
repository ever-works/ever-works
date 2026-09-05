import { summarizeDoD } from '../goal-dod';
import {
    decideGoalLoop,
    formatUsd,
    type GoalLoopInput,
    type GoalRoutingCandidate,
} from '../goal-orchestrator-rules';

/**
 * Autonomy layer — the orchestrator DECISION TABLE.
 *
 * Every branch that decides what an autonomous loop does next lives in
 * `decideGoalLoop`, so this suite is the real specification of the
 * feature: budget exceeded → pause, no progress → stuck, all criteria
 * closed → done, and the ORDER between them (finishing beats running out
 * of money; a ceiling beats being stuck).
 */

const NOW = new Date('2026-08-15T12:00:00.000Z');

function candidate(overrides: Partial<GoalRoutingCandidate> = {}): GoalRoutingCandidate {
    return { agentId: 'agent-1', name: 'Research', source: 'history', ...overrides };
}

function input(overrides: Partial<GoalLoopInput> = {}): GoalLoopInput {
    return {
        loopStatus: 'running',
        dod: summarizeDoD([{ id: 'a', text: 'do the thing', status: 'open' }]),
        iteration: 1,
        lastProgressIteration: 1,
        stuckThresholdIterations: null,
        spendCapCents: null,
        spentCents: 0,
        wallClockLimitHours: null,
        loopStartedAt: new Date('2026-08-15T10:00:00.000Z'),
        gracePeriodMinutes: null,
        hasRunInFlight: false,
        candidates: [candidate()],
        now: NOW,
        ...overrides,
    };
}

describe('decideGoalLoop — loop state', () => {
    it.each(['paused', 'done', 'cancelled', 'stuck', null] as const)(
        'does nothing when the loop is %s',
        (loopStatus) => {
            const decision = decideGoalLoop(input({ loopStatus }));
            expect(decision.action).toBe('noop');
            expect(decision.reasonCode).toBe('loop-not-running');
        },
    );
});

describe('decideGoalLoop — completion', () => {
    it('completes when every approved criterion is closed', () => {
        const decision = decideGoalLoop(
            input({
                dod: summarizeDoD([
                    { id: 'a', text: 'ship', status: 'done' },
                    { id: 'b', text: 'drop', status: 'waived' },
                ]),
            }),
        );
        expect(decision.action).toBe('complete');
        expect(decision.reasonCode).toBe('dod-complete');
        expect(decision.reasoning).toContain('1 done');
        expect(decision.reasoning).toContain('1 waived');
    });

    it('completion BEATS an exhausted budget', () => {
        // Finishing inside the last budgeted iteration must be recorded as
        // achieved, not as "paused: out of money" — the operator would
        // otherwise raise the cap to re-discover it was already done.
        const decision = decideGoalLoop(
            input({
                dod: summarizeDoD([{ id: 'a', text: 'ship', status: 'done' }]),
                spendCapCents: 1000,
                spentCents: 5000,
            }),
        );
        expect(decision.action).toBe('complete');
    });

    it('does not complete on an empty checklist', () => {
        const decision = decideGoalLoop(input({ dod: summarizeDoD([]) }));
        expect(decision.action).toBe('dispatch');
    });
});

describe('decideGoalLoop — budget + wall clock', () => {
    it('pauses when spend reaches the cap', () => {
        const decision = decideGoalLoop(input({ spendCapCents: 2500, spentCents: 2500 }));
        expect(decision.action).toBe('pause');
        expect(decision.reasonCode).toBe('spend-cap-exceeded');
        expect(decision.reasoning).toContain('$25.00');
    });

    it('keeps going while under the cap', () => {
        expect(decideGoalLoop(input({ spendCapCents: 2500, spentCents: 2499 })).action).toBe(
            'dispatch',
        );
    });

    it('pauses when the wall-clock limit is reached', () => {
        const decision = decideGoalLoop(
            input({
                wallClockLimitHours: 1,
                loopStartedAt: new Date('2026-08-15T10:00:00.000Z'),
            }),
        );
        expect(decision.action).toBe('pause');
        expect(decision.reasonCode).toBe('wall-clock-exceeded');
    });

    it('never trips the wall clock when the loop has no start anchor', () => {
        expect(decideGoalLoop(input({ wallClockLimitHours: 1, loopStartedAt: null })).action).toBe(
            'dispatch',
        );
    });

    it('waits out the grace period when a session is still running', () => {
        // 2h elapsed, 1h limit, 90m grace, run in flight → let it land.
        const decision = decideGoalLoop(
            input({
                wallClockLimitHours: 1,
                gracePeriodMinutes: 90,
                hasRunInFlight: true,
                loopStartedAt: new Date('2026-08-15T10:00:00.000Z'),
            }),
        );
        expect(decision.action).toBe('wait');
        expect(decision.reasonCode).toBe('grace-period');
    });

    it('pauses once the grace period itself is exhausted', () => {
        // 2h elapsed, 1h limit, 30m grace → 1h30m allowance is spent.
        const decision = decideGoalLoop(
            input({
                wallClockLimitHours: 1,
                gracePeriodMinutes: 30,
                hasRunInFlight: true,
                loopStartedAt: new Date('2026-08-15T10:00:00.000Z'),
            }),
        );
        expect(decision.action).toBe('pause');
        expect(decision.reasonCode).toBe('wall-clock-exceeded');
    });

    it('gives the SPEND cap no grace, even mid-session', () => {
        // A money ceiling that keeps spending for another 30 minutes is
        // not a ceiling.
        const decision = decideGoalLoop(
            input({
                spendCapCents: 1000,
                spentCents: 1000,
                gracePeriodMinutes: 30,
                hasRunInFlight: true,
            }),
        );
        expect(decision.action).toBe('pause');
        expect(decision.reasonCode).toBe('spend-cap-exceeded');
    });
});

describe('decideGoalLoop — stuck detection', () => {
    it('marks the loop stuck after N iterations with no DoD progress', () => {
        const decision = decideGoalLoop(
            input({ iteration: 7, lastProgressIteration: 4, stuckThresholdIterations: 3 }),
        );
        expect(decision.action).toBe('stuck');
        expect(decision.reasonCode).toBe('no-progress');
        expect(decision.reasoning).toContain('3 iteration(s)');
    });

    it('does not fire one iteration early', () => {
        expect(
            decideGoalLoop(
                input({ iteration: 6, lastProgressIteration: 4, stuckThresholdIterations: 3 }),
            ).action,
        ).toBe('dispatch');
    });

    it('never fires without a configured threshold', () => {
        expect(
            decideGoalLoop(
                input({ iteration: 99, lastProgressIteration: 0, stuckThresholdIterations: null }),
            ).action,
        ).toBe('dispatch');
    });

    it('reports the CEILING when a loop is both over budget and stuck', () => {
        // Over-budget and stuck have different operator remedies (raise the
        // cap vs change the plan); the ceiling is the one that stopped it.
        const decision = decideGoalLoop(
            input({
                iteration: 9,
                lastProgressIteration: 1,
                stuckThresholdIterations: 2,
                spendCapCents: 100,
                spentCents: 900,
            }),
        );
        expect(decision.reasonCode).toBe('spend-cap-exceeded');
    });

    it('marks stuck when there is nothing to route to', () => {
        const decision = decideGoalLoop(input({ candidates: [] }));
        expect(decision.action).toBe('stuck');
        expect(decision.reasonCode).toBe('no-candidate-agent');
    });
});

describe('decideGoalLoop — routing', () => {
    it('waits while an iteration is still in flight', () => {
        const decision = decideGoalLoop(input({ hasRunInFlight: true }));
        expect(decision.action).toBe('wait');
        expect(decision.reasonCode).toBe('run-in-flight');
    });

    it('always routes to the pinned agent, never round-robin', () => {
        const decision = decideGoalLoop(
            input({
                candidates: [
                    candidate({ agentId: 'hist-1' }),
                    candidate({ agentId: 'pinned', name: 'Builder', source: 'assigned' }),
                ],
            }),
        );
        expect(decision.action).toBe('dispatch');
        expect(decision.agentId).toBe('pinned');
        expect(decision.reasonCode).toBe('routed-assigned-agent');
        expect(decision.reasoning).toContain('Builder');
        expect(decision.reasoning).toContain('pins this agent');
    });

    it('round-robins over the goal history when nothing is pinned', () => {
        const candidates = [
            candidate({ agentId: 'a', name: 'Alpha' }),
            candidate({ agentId: 'b', name: 'Beta' }),
        ];
        // nextIteration = iteration + 1, and the pick is nextIteration % n,
        // so consecutive iterations visit different agents.
        expect(decideGoalLoop(input({ iteration: 0, candidates })).agentId).toBe('b');
        expect(decideGoalLoop(input({ iteration: 1, candidates })).agentId).toBe('a');
        expect(decideGoalLoop(input({ iteration: 2, candidates })).agentId).toBe('b');
    });

    it('advances the iteration counter on dispatch', () => {
        const decision = decideGoalLoop(input({ iteration: 4 }));
        expect(decision.nextIteration).toBe(5);
        expect(decision.reasoning).toContain('iteration 5');
    });

    it('falls back to the agent id when the candidate has no name', () => {
        const decision = decideGoalLoop(input({ candidates: [candidate({ name: null })] }));
        expect(decision.reasoning).toContain('agent-1');
    });
});

describe('decideGoalLoop — cold start (scope fallback, self-build slice AG)', () => {
    const scoped = [
        candidate({ agentId: 'a', name: 'Alpha', source: 'scope' }),
        candidate({ agentId: 'b', name: 'Beta', source: 'scope' }),
    ];

    it('dispatches to an in-scope agent and says so in the reasoning', () => {
        const decision = decideGoalLoop(input({ iteration: 0, candidates: scoped }));
        expect(decision.action).toBe('dispatch');
        expect(decision.reasonCode).toBe('routed-scope-fallback');
        expect(decision.nextIteration).toBe(1);
        // nextIteration = 1, 1 % 2 = 1 → Beta.
        expect(decision.agentId).toBe('b');
        expect(decision.reasoning).toContain('Beta');
        expect(decision.reasoning).toContain('no agent has worked it yet');
        expect(decision.reasoning).toContain("2 eligible agent(s) in the Goal's scope");
    });

    it('round-robins over the scope pool by the persisted iteration counter alone', () => {
        expect(decideGoalLoop(input({ iteration: 1, candidates: scoped })).agentId).toBe('a');
        expect(decideGoalLoop(input({ iteration: 2, candidates: scoped })).agentId).toBe('b');
        expect(decideGoalLoop(input({ iteration: 3, candidates: scoped })).agentId).toBe('a');
    });

    it('keeps the history reasoning untouched when the pool came from history', () => {
        const decision = decideGoalLoop(
            input({ candidates: [candidate({ agentId: 'h', name: 'Hist', source: 'history' })] }),
        );
        expect(decision.reasonCode).toBe('routed-round-robin');
        expect(decision.reasoning).not.toContain('scope');
    });

    it('a pin still beats scope candidates', () => {
        const decision = decideGoalLoop(
            input({
                candidates: [...scoped, candidate({ agentId: 'pin', source: 'assigned' })],
            }),
        );
        expect(decision.agentId).toBe('pin');
        expect(decision.reasonCode).toBe('routed-assigned-agent');
    });

    it('an empty pool is still an honest stuck, and points the operator at the Goal scope', () => {
        const decision = decideGoalLoop(input({ candidates: [] }));
        expect(decision.action).toBe('stuck');
        expect(decision.reasonCode).toBe('no-candidate-agent');
        expect(decision.reasoning).toContain("in this Goal's scope");
    });

    it('limits still beat routing: a spend cap pauses before any scope candidate is used', () => {
        const decision = decideGoalLoop(
            input({ candidates: scoped, spendCapCents: 100, spentCents: 500 }),
        );
        expect(decision.action).toBe('pause');
        expect(decision.agentId).toBeUndefined();
    });
});

describe('decideGoalLoop — Definition of Done approval (kind-agnostic)', () => {
    it('does not complete on proposed-only criteria — the loop keeps dispatching', () => {
        const decision = decideGoalLoop(
            input({
                dod: summarizeDoD([{ id: 'a', text: 'x', status: 'done', proposed: true }]),
            }),
        );
        expect(decision.action).toBe('dispatch');
    });

    it('completes once every APPROVED criterion is closed, even with proposals pending', () => {
        const decision = decideGoalLoop(
            input({
                dod: summarizeDoD([
                    { id: 'a', text: 'x', status: 'done' },
                    { id: 'p', text: 'y', status: 'open', proposed: true },
                ]),
            }),
        );
        expect(decision.action).toBe('complete');
        expect(decision.reasonCode).toBe('dod-complete');
    });
});

describe('formatUsd', () => {
    it('renders cents as dollars', () => {
        expect(formatUsd(0)).toBe('$0.00');
        expect(formatUsd(1234)).toBe('$12.34');
        expect(formatUsd(100_000)).toBe('$1000.00');
    });
});
