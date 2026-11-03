/**
 * APW-08 T46 (Resolution R-17, FR-66, FR-67; ACC-08-31) — how an App Work run that met a safety
 * rail ended, in the two words the evolve loop acts on. Pure.
 *
 * `AgentRunService.evaluateSafety` turns a `held` / `refused` verdict into a TOOL RESULT for the
 * model and the run carries on, so the run itself says nothing about it. The safety gate does,
 * though: every verdict that is not `allow` is recorded as a `rail_refusals` row carrying the
 * `runId`, the `railId` and the `category` (`SafetyGateService.evaluate`) — written by the gate,
 * never by the model. That record is what this classifier reads, on BOTH the cloud and the Fleet
 * path (they end every run through `TaskRunDenormService.recordTerminal`), so the outcome never
 * depends on the model choosing to report anything.
 *
 *  - **wait** (FR-66) — the run was parked (`queuedReason` `kill-switch` / `agent-paused`) or
 *    stopped by a STOP or PAUSE rail (`platform-stop`, `workspace-pause`, `scope-pause`): a person
 *    holds it. Not a failure: no gate attempt, no follow-up, and the Task is left where it is.
 *  - **needs_input** (FR-67) — any other `refused` or `held` verdict (`ladder`, `taxonomy`,
 *    `rules`, `grants`, `caps`): a refusal needs a decision, not a retry. The Task is BLOCKED with
 *    one `guardrail-refusal` escalation carrying the rail and the category only.
 *  - `null` — nothing held or refused the run.
 *
 * A wait wins over a refusal in the same run: an operator's stop is a person's hold on everything,
 * and blocking the Task on top of it would ask the owner to decide what the operator already did.
 */

/** The rails that STOP or PAUSE (a person's hold — wait). */
export const APP_WORK_RUN_STOP_RAILS: readonly string[] = [
    'platform-stop',
    'workspace-pause',
    'scope-pause',
];

/** The admission chain's park reasons that are a person's hold (wait). */
export const APP_WORK_RUN_PARK_REASONS: readonly string[] = ['kill-switch', 'agent-paused'];

/** One gate verdict of the run, as the `rail_refusals` row records it. */
export interface AppWorkRunRefusalFact {
    railId: string;
    category?: string | null;
    verdict?: string | null;
}

export type AppWorkRunStop =
    | { kind: 'wait'; cause: 'parked' | 'stop-rail'; detail: string }
    | { kind: 'needs_input'; railId: string; category: string | null }
    | null;

export function classifyAppWorkRunStop(input: {
    queuedReason?: string | null;
    /** The run's gate verdicts, OLDEST FIRST. */
    refusals?: readonly AppWorkRunRefusalFact[] | null;
}): AppWorkRunStop {
    const parked = (input.queuedReason ?? '').trim();
    if (parked && APP_WORK_RUN_PARK_REASONS.includes(parked)) {
        return { kind: 'wait', cause: 'parked', detail: parked };
    }
    const refusals = (input.refusals ?? []).filter(
        (refusal) =>
            !!refusal &&
            typeof refusal.railId === 'string' &&
            refusal.railId.length > 0 &&
            (refusal.verdict === undefined ||
                refusal.verdict === null ||
                refusal.verdict === 'refused' ||
                refusal.verdict === 'held'),
    );
    const stop = refusals.find((refusal) => APP_WORK_RUN_STOP_RAILS.includes(refusal.railId));
    if (stop) return { kind: 'wait', cause: 'stop-rail', detail: stop.railId };
    // The FIRST non-stop verdict is the one the owner is asked about.
    const first = refusals[0];
    if (!first) return null;
    return { kind: 'needs_input', railId: first.railId, category: first.category ?? null };
}
