/**
 * APW-05 T18 — the payload of the `app-build-prepare` job (plan §7.1:1312-1314).
 *
 * `AppBuildsService.requestPrepare(workId, reason, buildId?)` is the only thing that
 * raises one (§7.2:1366-1369): the `app.spec.applied` listener, Rebuild, a verification
 * request and a pull-token save all go through it, and §7.2's coalescing dispatch is the
 * same payload with `reason: 'coalesced'`.
 *
 * **Ids and a reason only** — never a build value, never a repository coordinate, never
 * the `prepareSeq` the dispatch is racing. A job runtime replays the ORIGINAL payload on a
 * retry, so anything mutable carried here would become a stale decision; the runner
 * re-reads the Work, the preparation row and the Build rows itself (§7.2:1373-1375), which
 * is also why `buildId` is advisory — "a coalesced dispatch loses nothing" without it.
 *
 * ## Where the reason vocabulary lives
 *
 * §7.1 spells nine reasons (`specApplied` · `envChanged` · `rebuild` · `verification` ·
 * `pullTokenSaved` · `workflowMerged` · `settingsChanged` · `actionsEnabled` · `coalesced`),
 * and T21's sweep adds a tenth, `sweep` — its re-drive of a requested Build nothing
 * dispatched (§9.2). They are declared once as `APP_BUILD_PREPARE_REASONS` /
 * `AppBuildPrepareReason` (`packages/agent/src/app-builds/app-builds.service.ts`); this
 * interface keeps the wide `string` field so that all three declarations of this payload
 * stay mutually assignable, and so a new reason is never a breaking wire change — see the
 * duplication note below.
 *
 * ## 🛑 Three declarations of one payload (routed as a finding, not resolved here)
 *
 * This interface, T17's `AppBuildPrepareJobPayload`
 * (`packages/agent/src/app-builds/app-builds.service.ts:95-99`) and T19's
 * `AppBuildPrepareTaskPayload`
 * (`packages/tasks/src/tasks/trigger/app-build-prepare.task.ts:80-85`) declare the same
 * shape. They agree field for field today — `workId: string`, `buildId?: string`, and a
 * reason — and this file is deliberately the WIDEST of the three (a plain `string` reason)
 * so a value typed by either sibling is assignable to it, and a value typed here is
 * assignable to both. Which one becomes the single home is a call for whoever lands
 * T17 + T18 + T19 together; T19's file header already records that its payload is local
 * only "until" this file exists.
 */
export const APP_BUILD_PREPARE_TASK_ID = 'app-build-prepare' as const;

/**
 * One `app-build-prepare` dispatch.
 *
 * Field-for-field identical to T19's `AppBuildPrepareTaskPayload` — the worker's own
 * declaration of the same message — so the two can never disagree about what is on the
 * wire. The `reason` is recorded by the job, never trusted to skip work (§7.2 re-reads
 * every gate), which is why the field is a `string` here rather than the closed union:
 * a new reason must not be a breaking wire change for an older worker.
 */
export interface AppBuildPreparePayload {
    /** The App Work to prepare. A uuid in production. */
    workId: string;
    /**
     * The Build that asked for this prepare, when one did.
     *
     * **Advisory on purpose.** The runner numbers the Builds it acts on from the database
     * (§7.2:1374-1375), so a coalesced dispatch that arrives without it loses nothing.
     */
    buildId?: string;
    /**
     * One of the ten reasons — §7.1's `specApplied`, `envChanged`, `rebuild`, `verification`,
     * `pullTokenSaved`, `workflowMerged`, `settingsChanged`, `actionsEnabled`, `coalesced`, and
     * the sweep's `sweep`.
     */
    reason: string;
}
