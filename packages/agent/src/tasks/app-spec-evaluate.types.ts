import type { AppSpecEvaluationTrigger } from '@ever-works/contracts';

/**
 * APW-03 T13 — the payload of the `app-spec-evaluate` job.
 *
 * Plan §6.1 (`plan.md:650`) fixes the shape and the budget:
 *
 * | Job id | Dispatcher symbol | Payload | Budget |
 * | ------ | ----------------- | ------- | ------ |
 * | `app-spec-evaluate` | `APP_SPEC_EVALUATE_DISPATCHER` | `{ workId, trigger, tenantId, organizationId, providerId?, credentialVersion? }` | 60 s, retries 2 |
 *
 * The job **always reads the current head**, never the commit a dispatch was
 * raised for (plan §2.3:193): "The job always reads the current head, never the
 * event's sha". That is why the payload carries no sha — a queued dispatch that
 * sat behind a burst of pushes must evaluate what is on the branch *now*, and
 * the `evaluatedSeq` guard is what keeps an older job from overwriting a newer
 * result. It is also why no payload field is a decision: `trigger` is recorded,
 * never trusted to skip work.
 *
 * `tenantId` / `organizationId` / `providerId` / `credentialVersion` are the
 * EW-742 P3.1 enqueue-site binding capture every dispatcher in this package
 * carries (see `KbEmbedDocumentPayload` and `WorkImportPayload`): they let the
 * worker host resolve the same credential snapshot the API enqueued under. All
 * four are optional and fail open — absent means "resolve the current binding",
 * exactly as those dispatchers document.
 */
export interface AppSpecEvaluatePayload {
    /** The App Work whose App spec is evaluated. A uuid in production. */
    workId: string;
    /** What asked for this evaluation — recorded on the state row, never trusted to skip work. */
    trigger: AppSpecEvaluationTrigger;
    /** EW-742 P3.1 scope stamp, or `null`/absent when the caller has none. */
    tenantId?: string | null;
    /** EW-742 P3.1 scope stamp, or `null`/absent when the caller has none. */
    organizationId?: string | null;
    /** The git provider to read the Work Repository through; `github` when absent. */
    providerId?: string | null;
    /** EW-742 P3.1 credential snapshot version; `null`/absent means "current". */
    credentialVersion?: number | null;
}
