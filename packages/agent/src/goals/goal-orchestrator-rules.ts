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
     * Where the candidate came from — `assigned` (operator pin),
     * `history` (has already worked an iteration of this goal), or
     * `scope` (cold start: an eligible agent in the Goal's own
     * Organization / tenant scope, offered only when there is no pin and
     * no history — self-build slice AG, finding R1).
     */
    source: 'assigned' | 'history' | 'scope';
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
    | 'routed-round-robin'
    | 'routed-scope-fallback';

export interface GoalLoopDecision {
    action: GoalLoopAction;
    reasonCode: GoalLoopReasonCode;
    /** Verbatim orchestrator-log line. */
    reasoning: string;
    /** Set only when `action === 'dispatch'`. The FIRST slot's agent. */
    agentId?: string;
    /** The iteration number this decision produces (dispatch only). The FIRST slot's. */
    nextIteration?: number;
    /**
     * Concurrent iterations (slice AH) — one entry per slot this decision
     * dispatches, in order. Always present on a `dispatch`, and always
     * length 1 unless the Goal opted into `maxConcurrentIterations > 1`,
     * so `agentId` / `nextIteration` above stay the whole answer for
     * every caller that predates the field.
     */
    agentIds?: string[];
    /** Iteration numbers for {@link agentIds}, positionally paired. */
    iterations?: number[];
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
    /**
     * Concurrent iterations (slice AH) — HOW MANY iteration runs are in
     * flight. Absent falls back to `hasRunInFlight ? 1 : 0`, which is
     * what every caller written before this field effectively said, so
     * omitting it changes nothing.
     */
    runsInFlight?: number | null;
    /**
     * Concurrent iterations (slice AH) — how many iterations this Goal
     * may have in flight at once. Absent / null / `<= 1` all mean ONE,
     * which is the serial loop every existing Goal runs; a Goal only
     * speeds up when someone raises it deliberately.
     */
    maxConcurrentIterations?: number | null;
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
 *  6. **Concurrency ceiling reached** → wait. By default the ceiling is
 *     ONE, i.e. "a run is in flight" — a second concurrent iteration
 *     would race the first one's workspace. A Goal whose iterations do
 *     NOT share a branch can raise `maxConcurrentIterations`, and the
 *     branch then waits only once that many are in flight; the tick
 *     dispatches the free slots in one decision (`agentIds` /
 *     `iterations`). Nothing changes for a Goal that never sets it.
 *  7. **No candidate agent** → stuck. Honest degradation: a loop with
 *     nothing to route to is not "running", it is waiting on a human.
 *     (The service already widened the pool to the Goal's scope for a
 *     fresh Goal, so reaching here means the scope has no agent at all.)
 *  8. Otherwise → dispatch, pinned agent first, else round-robin over
 *     the history — or, for a fresh unpinned Goal, over the eligible
 *     agents of its scope (`routed-scope-fallback`).
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

    // Concurrent iterations (slice AH). At the default ceiling of ONE
    // this reduces to `if (input.hasRunInFlight)` — same branch, same
    // reasonCode, same reasoning string — which is what keeps every
    // pre-existing decision-table case byte-identical.
    const maxConcurrent = resolveMaxConcurrentIterations(input.maxConcurrentIterations);
    const runsInFlight = resolveRunsInFlight(input);
    if (runsInFlight >= maxConcurrent) {
        return {
            action: 'wait',
            reasonCode: 'run-in-flight',
            reasoning:
                maxConcurrent === 1
                    ? `Iteration ${input.iteration} is still running — router waiting.`
                    : `${runsInFlight} of ${maxConcurrent} concurrent iterations are still ` +
                      'running — router waiting for a slot.',
        };
    }

    if (input.candidates.length === 0) {
        return {
            action: 'stuck',
            reasonCode: 'no-candidate-agent',
            reasoning:
                "No agent is available to run this Goal — create or assign an agent in this Goal's " +
                'scope (or run one iteration manually) before the loop can route work.',
        };
    }

    // Free slots this tick: the ceiling minus what is already running, so
    // a Goal at 3 of 4 dispatches ONE more, never four.
    const slots = maxConcurrent - runsInFlight;
    const nextIteration = input.iteration + 1;
    const iterations = Array.from({ length: slots }, (_, index) => nextIteration + index);
    const plural = slots > 1;
    const pinned = input.candidates.find((candidate) => candidate.source === 'assigned');
    if (pinned) {
        // A pin is a pin: every free slot goes to it. Round-robin exists
        // to spread work the operator did NOT direct.
        return {
            action: 'dispatch',
            reasonCode: 'routed-assigned-agent',
            agentId: pinned.agentId,
            nextIteration,
            agentIds: iterations.map(() => pinned.agentId),
            iterations,
            reasoning: plural
                ? `Routed iterations ${describeIterations(iterations)} → ${label(pinned)}: the Goal ` +
                  `pins this agent, so routing never round-robins; ${slots} of ${maxConcurrent} ` +
                  'concurrent slots were free.'
                : `Routed iteration ${nextIteration} → ${label(pinned)}: the Goal pins this agent, ` +
                  'so routing never round-robins.',
        };
    }

    // Round-robin keyed on the iteration ABOUT to run, so consecutive
    // iterations visit different agents and the sequence is reproducible
    // from the persisted counter alone (no hidden cursor to drift).
    const chosenAgents = iterations.map(
        (iteration) => input.candidates[iteration % input.candidates.length],
    );
    const chosen = chosenAgents[0];
    const agentIds = chosenAgents.map((candidate) => candidate.agentId);
    const routed = chosenAgents.map((candidate) => label(candidate)).join(', ');
    if (chosen.source === 'scope') {
        // Cold start: nobody has worked this Goal yet, so the service
        // offered the eligible agents of the Goal's own scope. The log line
        // says so explicitly — an operator must be able to tell "routed to
        // the agent that already knows this Goal" from "routed to whoever
        // is in the Organization".
        return {
            action: 'dispatch',
            reasonCode: 'routed-scope-fallback',
            agentId: chosen.agentId,
            nextIteration,
            agentIds,
            iterations,
            reasoning: plural
                ? `Routed iterations ${describeIterations(iterations)} → ${routed}: the Goal pins no ` +
                  'agent and no agent has worked it yet, so the router round-robins over the ' +
                  `${input.candidates.length} eligible agent(s) in the Goal's scope; ${slots} of ` +
                  `${maxConcurrent} concurrent slots were free.`
                : `Routed iteration ${nextIteration} → ${label(chosen)}: the Goal pins no agent and no ` +
                  'agent has worked it yet, so the router round-robins over the ' +
                  `${input.candidates.length} eligible agent(s) in the Goal's scope.`,
        };
    }
    return {
        action: 'dispatch',
        reasonCode: 'routed-round-robin',
        agentId: chosen.agentId,
        nextIteration,
        agentIds,
        iterations,
        reasoning: plural
            ? `Routed iterations ${describeIterations(iterations)} → ${routed}: the Goal pins no ` +
              `agent, so the router round-robins over ${input.candidates.length} agent(s) that have ` +
              `worked this Goal; ${slots} of ${maxConcurrent} concurrent slots were free.`
            : `Routed iteration ${nextIteration} → ${label(chosen)}: the Goal pins no agent, so the ` +
              `router round-robins over ${input.candidates.length} agent(s) that have worked this Goal.`,
    };
}

/**
 * Concurrent iterations (slice AH) — the ceiling, normalized.
 *
 * Absent, null, NaN and anything `<= 1` all collapse to ONE, which is
 * the serial behaviour every Goal has always had. Raising it is opt-in
 * per Goal and appropriate only where iterations do not share a branch:
 * the `wait` branch it relaxes exists because "a second concurrent
 * iteration would race the first one's workspace".
 */
function resolveMaxConcurrentIterations(raw: number | null | undefined): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1;
    return Math.max(1, Math.trunc(raw));
}

/**
 * How many iterations are in flight: `runsInFlight` when the caller
 * counted them, else the boolean every pre-AH caller supplied.
 */
function resolveRunsInFlight(input: GoalLoopInput): number {
    if (typeof input.runsInFlight === 'number' && Number.isFinite(input.runsInFlight)) {
        return Math.max(0, Math.trunc(input.runsInFlight));
    }
    return input.hasRunInFlight ? 1 : 0;
}

/** `12` / `12 and 13` / `12, 13 and 14` for the multi-slot log line. */
function describeIterations(iterations: number[]): string {
    if (iterations.length === 1) return String(iterations[0]);
    const head = iterations.slice(0, -1).join(', ');
    return `${head} and ${iterations[iterations.length - 1]}`;
}

/** Cents → a `$12.34` string for the log line. */
export function formatUsd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

function label(candidate: GoalRoutingCandidate): string {
    return candidate.name?.trim() || candidate.agentId;
}
