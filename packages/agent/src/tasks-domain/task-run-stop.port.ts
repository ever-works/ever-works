/**
 * APW-08 T46 (R-17, FR-67) — told when a Task's run reached a terminal state, so an App Work run a
 * safety rail refused can end as `needs_input` (Task BLOCKED + a `guardrail-refusal` escalation).
 *
 * Asked by `TaskRunDenormService.recordTerminal`, the one write BOTH run paths make when a run
 * ends (the cloud worker over its RPC proxy, the Fleet reconciler in process), so the cloud
 * finisher and the Fleet reconciler need no change of their own. Bound in `TasksDomainModule` to
 * `AppWorkRunHoldsService`; absent, nothing happens. Best-effort by contract: never throws, and
 * the caller does not wait on it.
 *
 * 🛑 A leaf (a Symbol and an interface): `TaskRunDenormService` reads the token in a parameter
 * decorator.
 */
export const APP_WORK_RUN_STOP_HANDLER = Symbol('APP_WORK_RUN_STOP_HANDLER');

export interface AppWorkRunStopHandler {
    onRunTerminal(input: {
        taskId: string;
        runId: string;
        status: 'completed' | 'failed' | 'cancelled';
    }): Promise<void>;
}
