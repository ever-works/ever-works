import type { AppSpecEvaluatePayload } from './app-spec-evaluate.types';

/**
 * APW-03 T13 — producer-side interface for the `app-spec-evaluate` job
 * (plan §6.1:650, `tasks.md:307-320`), implemented by the configured job-runtime
 * provider (Constitution IV).
 *
 * `AppSpecService.requestEvaluation` is the only caller, and it is called from
 * every door FR-19 names — a push, a merged pull request, **Re-check now**, the
 * lazy head check, a Blueprint apply, App Work creation and a Build's
 * pre-flight — so this is the busiest seam in the epic.
 *
 * ## Why `null` is an answer here, not a failure
 *
 * Plan §6.1:661-662:
 *
 * > A `null` dispatch (no runtime) runs the handler **in-process for
 * > `app-spec-evaluate` only** (a user is waiting on the page); the other two
 * > record `lastEvaluationError: 'dispatchUnavailable'`.
 *
 * `app-spec-evaluate` is the one job this epic runs in the API process when no
 * runtime is registered, and FR-90 requires exactly that: "the evaluation, its
 * database writes and its in-process events MUST happen in the API process, so
 * the events other epics listen for are actually delivered". A `null` therefore
 * means "no runtime is configured — run it now", which is a defined behaviour and
 * not a dropped job. {@link APP_SPEC_EVALUATE_DISPATCHER}'s `null` is the only
 * value `AppSpecService` treats that way; nothing else is inferred from it.
 *
 * The sibling `app-license-evaluate` and `app-blueprint-apply` dispatchers
 * (T31/T40, not in this file's task) keep the `string | null` shape but record
 * `dispatchUnavailable` instead — the difference is a property of the CALLER,
 * not of the runtime, so the three stay one interface shape.
 *
 * Mirrors {@link WorkImportDispatcher} — the other `string | null` dispatcher in
 * this package — so the binding factory in `job-runtime.providers.ts` wires it
 * with no special case.
 */
export interface AppSpecEvaluateDispatcher {
    /**
     * Enqueue one App spec evaluation.
     *
     * @returns the job runtime's run id, or `null` when no runtime is configured
     *   (or the active runtime exposes no such dispatch method) — in which case
     *   the caller runs the same handler in-process.
     */
    dispatchAppSpecEvaluate(payload: AppSpecEvaluatePayload): Promise<string | null>;
}

export const APP_SPEC_EVALUATE_DISPATCHER = Symbol('APP_SPEC_EVALUATE_DISPATCHER');
