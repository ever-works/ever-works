/**
 * APW-08 T56 (XC-19, FR-73, FR-66) — the WORK BUDGET port for the run admission chain.
 *
 * Contract only (leaf file, zero imports — the same circular-dep dodge as
 * `run-agent-brake.ts` and `run-kill-switch.ts`).
 *
 * Why a port and not a token: the dispatch gate builds the chain's context from its own
 * constructor, and its constructor is not this task's to change (a parallel lane holds it). The
 * middleware that asks this port is therefore built as a CLOSURE over it
 * (`createWorkBudgetAdmission(port)`) and handed to the gate through the seam the gate already
 * documents for exactly this — `RunDispatchGateService.withAdmissionChain` ("a future install
 * that adds, say, a maintenance-window middleware"). `AppWorkBudgetAdmissionInstaller`
 * (`app-works/app-work-budget.ts`) does that once, at module init, in the process that owns the
 * gate; the Trigger worker reaches the same gate through its RPC proxy, so every admission —
 * the first dispatch and every drain — crosses the same chain.
 *
 * The implementation (`AppWorkBudgetService`) answers for **App Works only**: every other Work
 * kind, and a run with no Work, is never parked by it.
 *
 * Fail-OPEN at the consumer, like the credits precheck and unlike the stop flag and the brake:
 * this is a billing check, and a broken billing check must never stop work. A budget the guard
 * could read and found spent parks the run; a guard that THREW is not a spent budget.
 */
export interface RunWorkBudget {
    /**
     * True ⇒ the run's Work has spent its budget for the period ⇒ park the run (a wait, FR-66).
     * May throw; the middleware then admits the run (fail-open) and logs why.
     */
    shouldParkForWorkBudget(input: {
        userId: string;
        workId?: string | null;
        agentId?: string | null;
    }): Promise<boolean>;
}
