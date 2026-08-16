import type { GoalDoDSummary } from './goal-dod';

/**
 * Autonomy layer — the ROUTING / ADVANCE decision, as a pure function.
 *
 * Every branch that decides what an autonomous loop does next lives here
 * and nowhere else. The service around it does I/O (read the goal, roll
 * up spend, create a Task, write a log row) but makes no decisions, so
 * the decision table is exhaustively unit-testable without a database,
 * a job runtime, or an agent.
 *
 * v1 is DELIBERATELY deterministic — no model is consulted to pick an
 * agent. The `reasoning` string every decision carries is the literal
 * text persisted to the orchestrator log, which is why it names the
 * inputs that produced the decision rather than summarizing them: an
 * operator reading "routed to X because the goal pins no agent and X is
 * next of 2 candidates" can verify the claim; one reading "routed to X"
 * cannot.
 */

/** One agent the router may choose between. */
export interface GoalRoutingCandidate {
    agentId: string;
    /** Display name for the reasoning string; falls back to the id. */
    name?: string | null;
    /**
     * Where the candidate came from — `assigned` (operator pin) or
     * `history` (has already worked an iteration of this goal).
     */
    source: 'assigned' | 'history';
}

export type GoalLoopAction =
    /** Create + dispatch the next iteration Task to `agentId`. */
    | 'dispatch'
    /** Every approved DoD criterion is closed — the loop is finished. */
    | 'complete'
    /** A budget / wall-clock ceiling tripped; the loop pauses. */
    | 'pause'
    /** No progress for `stuckThresholdIterations`, or nothing to route to. */
    | 'stuck'
    /** An iteration is still in flight; do nothing this tick. */
    | 'wait'
    /** The loop is not running (paused/done/cancelled/never started). */
    | 'noop';

/** Stable machine-readable discriminator behind `reasoning`. */
export type GoalLoopReasonCode =
    | 'loop-not-running'
    | 'dod-complete'
    | 'spend-cap-exceeded'
    | 'wall-clock-exceeded'
    | 'no-progress'
    | 'run-in-flight'
    | 'grace-period'
    | 'no-candidate-agent'
    | 'routed-assigned-agent'
    | 'routed-round-robin';

export interface GoalLoopDecision {
    action: GoalLoopAction;
    reasonCode: GoalLoopReasonCode;
    /** Verbatim orchestrator-log line. */
    reasoning: string;
    /** Set only when `action === 'dispatch'`. */
    agentId?: string;
    /** The iteration number this decision produces (dispatch only). */
    nextIteration?: number;
}

export interface GoalLoopInput {
    loopStatus: 'running' | 'paused' | 'done' | 'cancelled' | 'stuck' | null | undefined;
    dod: GoalDoDSummary;
    iteration: number;
    lastProgressIteration: number;
    /** Approved DoD criteria closed since `lastProgressIteration` changed. */
    stuckThresholdIterations?: number | null;
    spendCapCents?: number | null;
    spentCents: number;
    wallClockLimitHours?: number | null;
    loopStartedAt?: Date | null;
    gracePeriodMinutes?: number | null;
    /** True when an iteration Task still has a queued/running agent run. */
    hasRunInFlight: boolean;
    candidates: GoalRoutingCandidate[];
    now: Date;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * Decide what the loop does next.
 *
 * Order matters and is the contract:
 *
 *  1. **Not running** → nothing. A paused/cancelled loop is never advanced
 *     by the cron, and `noop` is not an error.
 *  2. **DoD complete** → done. Checked BEFORE the limits so a goal that
 *     finished its last criterion inside its final budgeted iteration is
 *     recorded as achieved, not as "paused: out of budget". Finishing
 *     beats running out.
 *  3. **Spend cap** → pause.
 *  4. **Wall clock** → pause.
 *  5. **No progress for N iterations** → stuck. After the ceilings,
 *     because a loop that is both over budget AND stuck should report the
 *     ceiling: that is the actionable fact, and the operator surface for
 *     it (raise the cap) differs from the one for stuck (change the plan).
 *  6. **Run in flight** → wait. A second concurrent iteration would race
 *     the first one's workspace.
 *  7. **No candidate agent** → stuck. Honest degradation: a loop with
 *     nothing to route to is not "running", it is waiting on a human.
 *  8. Otherwise → dispatch, pinned agent first, else round-robin.
 *
 * `gracePeriodMinutes` extends the WALL-CLOCK limit only, and only while
 * an iteration is actually in flight: the point is to let a session that
 * is mid-write land instead of being abandoned by a clock. It is
 * deliberately NOT applied to the spend cap — a money ceiling that keeps
 * spending for another 30 minutes is not a ceiling.
 */
export function decideGoalLoop(input: GoalLoopInput): GoalLoopDecision {
    if (input.loopStatus !== 'running') {
        return {
            action: 'noop',
            reasonCode: 'loop-not-running',
            reasoning: `Loop is ${input.loopStatus ?? 'not started'} — no action taken.`,
        };
    }

    if (input.dod.complete) {
        return {
            action: 'complete',
            reasonCode: 'dod-complete',
            reasoning:
                `Definition of Done satisfied — ${input.dod.done} done, ${input.dod.waived} waived, ` +
                `0 open. Goal loop finished at iteration ${input.iteration}.`,
        };
    }

    if (
        typeof input.spendCapCents === 'number' &&
        input.spendCapCents >= 0 &&
        input.spentCents >= input.spendCapCents
    ) {
        return {
            action: 'pause',
            reasonCode: 'spend-cap-exceeded',
            reasoning:
                `Spend cap reached — ${formatUsd(input.spentCents)} of ${formatUsd(input.spendCapCents)} ` +
                `used across ${input.iteration} iteration(s). Loop paused; raise the cap to continue.`,
        };
    }

    const elapsedMs = input.loopStartedAt
        ? input.now.getTime() - input.loopStartedAt.getTime()
        : null;
    if (
        typeof input.wallClockLimitHours === 'number' &&
        input.wallClockLimitHours > 0 &&
        elapsedMs !== null &&
        elapsedMs >= input.wallClockLimitHours * MS_PER_HOUR
    ) {
        const graceMs =
            typeof input.gracePeriodMinutes === 'number' && input.gracePeriodMinutes > 0
                ? input.gracePeriodMinutes * MS_PER_MINUTE
                : 0;
        // The grace period exists so an iteration already mid-write is
        // allowed to land rather than being abandoned by a clock. It
        // therefore only applies while a run is actually in flight, and it
        // is BOUNDED — a grace period that waits forever is not a limit.
        if (
            graceMs > 0 &&
            input.hasRunInFlight &&
            elapsedMs < input.wallClockLimitHours * MS_PER_HOUR + graceMs
        ) {
            return {
                action: 'wait',
                reasonCode: 'grace-period',
                reasoning:
                    `Wall-clock limit of ${input.wallClockLimitHours}h reached, but iteration ` +
                    `${input.iteration} is still running — waiting up to ${input.gracePeriodMinutes}m ` +
                    'of grace for it to land before pausing.',
            };
        }
        return {
            action: 'pause',
            reasonCode: 'wall-clock-exceeded',
            reasoning:
                `Wall-clock limit reached — ${(elapsedMs / MS_PER_HOUR).toFixed(1)}h elapsed of ` +
                `${input.wallClockLimitHours}h allowed. Loop paused; raise the limit to continue.`,
        };
    }

    const iterationsWithoutProgress = input.iteration - input.lastProgressIteration;
    if (
        typeof input.stuckThresholdIterations === 'number' &&
        input.stuckThresholdIterations > 0 &&
        iterationsWithoutProgress >= input.stuckThresholdIterations
    ) {
        return {
            action: 'stuck',
            reasonCode: 'no-progress',
            reasoning:
                `No Definition-of-Done progress in ${iterationsWithoutProgress} iteration(s) ` +
                `(threshold ${input.stuckThresholdIterations}). Loop marked stuck — a human decision is needed.`,
        };
    }

    if (input.hasRunInFlight) {
        return {
            action: 'wait',
            reasonCode: 'run-in-flight',
            reasoning: `Iteration ${input.iteration} is still running — router waiting.`,
        };
    }

    if (input.candidates.length === 0) {
        return {
            action: 'stuck',
            reasonCode: 'no-candidate-agent',
            reasoning:
                'No agent is available to run this Goal — assign an agent to the Goal (or run one ' +
                'iteration manually) before the loop can route work.',
        };
    }

    const nextIteration = input.iteration + 1;
    const pinned = input.candidates.find((candidate) => candidate.source === 'assigned');
    if (pinned) {
        return {
            action: 'dispatch',
            reasonCode: 'routed-assigned-agent',
            agentId: pinned.agentId,
            nextIteration,
            reasoning:
                `Routed iteration ${nextIteration} → ${label(pinned)}: the Goal pins this agent, ` +
                'so routing never round-robins.',
        };
    }

    // Round-robin keyed on the iteration ABOUT to run, so consecutive
    // iterations visit different agents and the sequence is reproducible
    // from the persisted counter alone (no hidden cursor to drift).
    const chosen = input.candidates[nextIteration % input.candidates.length];
    return {
        action: 'dispatch',
        reasonCode: 'routed-round-robin',
        agentId: chosen.agentId,
        nextIteration,
        reasoning:
            `Routed iteration ${nextIteration} → ${label(chosen)}: the Goal pins no agent, so the ` +
            `router round-robins over ${input.candidates.length} agent(s) that have worked this Goal.`,
    };
}

/** Cents → a `$12.34` string for the log line. */
export function formatUsd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

function label(candidate: GoalRoutingCandidate): string {
    return candidate.name?.trim() || candidate.agentId;
}
