import { summarizeDoD } from '../goal-dod';
import {
    decideGoalLoop,
    type GoalLoopInput,
    type GoalRoutingCandidate,
} from '../goal-orchestrator-rules';

/**
 * APW-08 T32 (FR-47, FR-48; ACC-08-25 unit half) — a Goal scoped to an App Work:
 *
 *  - an iteration whose pull request is still open holds a concurrency slot until it merges or
 *    closes (S10: "Waiting for iteration 3's pull request to be merged or closed.");
 *  - a Work that is gone pauses the loop (S26: "The Work this Goal was scoped to no longer
 *    exists."), after "finished" and before every ceiling.
 *
 * Absent fields change nothing: the existing `goal-orchestrator-rules.spec.ts` table holds.
 */

const NOW = new Date('2026-10-31T12:00:00.000Z');

function candidate(overrides: Partial<GoalRoutingCandidate> = {}): GoalRoutingCandidate {
    return { agentId: 'agent-1', name: 'App Engineer', source: 'history', ...overrides };
}

function input(overrides: Partial<GoalLoopInput> = {}): GoalLoopInput {
    return {
        loopStatus: 'running',
        dod: summarizeDoD([{ id: 'a', text: 'Customer self-service', status: 'open' }]),
        iteration: 3,
        lastProgressIteration: 3,
        stuckThresholdIterations: null,
        spendCapCents: null,
        spentCents: 0,
        wallClockLimitHours: null,
        loopStartedAt: new Date('2026-10-31T10:00:00.000Z'),
        gracePeriodMinutes: null,
        hasRunInFlight: false,
        candidates: [candidate()],
        now: NOW,
        ...overrides,
    };
}

describe('decideGoalLoop — awaiting merge (FR-47, S10)', () => {
    it('an open pull request at the default ceiling of one waits, in the words of S10', () => {
        const decision = decideGoalLoop(
            input({ pullRequestsAwaitingMerge: 1, awaitingMergeIterations: [3] }),
        );
        expect(decision).toEqual({
            action: 'wait',
            reasonCode: 'awaiting-merge',
            reasoning: "Waiting for iteration 3's pull request to be merged or closed.",
        });
    });

    it('names several iterations, or counts them when their numbers are unknown', () => {
        expect(
            decideGoalLoop(
                input({
                    maxConcurrentIterations: 2,
                    pullRequestsAwaitingMerge: 2,
                    awaitingMergeIterations: [2, 3],
                }),
            ).reasoning,
        ).toBe('Waiting for the pull requests of iterations 2 and 3 to be merged or closed.');
        expect(
            decideGoalLoop(input({ pullRequestsAwaitingMerge: 1, awaitingMergeIterations: [] }))
                .reasoning,
        ).toBe('Waiting for 1 pull request from this Goal to be merged or closed.');
    });

    it('open pull requests and running iterations share one ceiling; the free slots are what is left', () => {
        const decision = decideGoalLoop(
            input({
                maxConcurrentIterations: 4,
                runsInFlight: 1,
                hasRunInFlight: true,
                pullRequestsAwaitingMerge: 2,
                awaitingMergeIterations: [2, 3],
            }),
        );
        expect(decision.action).toBe('dispatch');
        expect(decision.iterations).toEqual([4]);
    });

    it('a ceiling the RUNS alone fill still reads as run-in-flight (the older reason wins)', () => {
        const decision = decideGoalLoop(
            input({
                hasRunInFlight: true,
                pullRequestsAwaitingMerge: 1,
                awaitingMergeIterations: [2],
            }),
        );
        expect(decision.reasonCode).toBe('run-in-flight');
    });

    it('absent, zero and garbage counts change nothing: the next iteration dispatches', () => {
        for (const pullRequestsAwaitingMerge of [undefined, null, 0, -2, Number.NaN]) {
            const decision = decideGoalLoop(input({ pullRequestsAwaitingMerge }));
            expect(decision.action).toBe('dispatch');
            expect(decision.iterations).toEqual([4]);
        }
    });
});

describe('decideGoalLoop — the Work is gone (FR-48, S26)', () => {
    it('pauses with the S26 message and dispatches nothing', () => {
        expect(decideGoalLoop(input({ workUnavailable: true }))).toEqual({
            action: 'pause',
            reasonCode: 'work-unavailable',
            reasoning: 'The Work this Goal was scoped to no longer exists.',
        });
    });

    it('finishing still beats it, and it beats the ceilings (the Work is the actionable fact)', () => {
        expect(
            decideGoalLoop(
                input({
                    workUnavailable: true,
                    dod: summarizeDoD([{ id: 'a', text: 'Customer self-service', status: 'done' }]),
                }),
            ).reasonCode,
        ).toBe('dod-complete');
        expect(
            decideGoalLoop(input({ workUnavailable: true, spendCapCents: 100, spentCents: 500 }))
                .reasonCode,
        ).toBe('work-unavailable');
    });

    it('an unreadable Work waits: no pause, no dispatch (review of #3058)', () => {
        expect(decideGoalLoop(input({ workUnreadable: true }))).toEqual({
            action: 'wait',
            reasonCode: 'work-unreadable',
            reasoning: "The Goal's Work could not be read — trying again on the next tick.",
        });
    });

    it('a loop that is not running is left alone', () => {
        expect(decideGoalLoop(input({ loopStatus: 'paused', workUnavailable: true })).action).toBe(
            'noop',
        );
    });
});
