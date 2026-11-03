import { logger, task } from '@trigger.dev/sdk';
import {
    AppWorkIsolationBackfillRunner,
    type AppWorkIsolationBackfillSummary,
} from '@ever-works/agent/tasks-domain';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * APW-08 T50 — the ONE-SHOT `app-work-isolation-backfill` task (APW08-G07, ACC-08-43).
 *
 * Fills `taskIsolation`, `taskIsolationBaseBranch` and `taskIsolationTargetRepo` on every App Work
 * created before T11's `app.spec.applied` listener existed — the listener fires only on an
 * effective-hash change, so those Works are never visited and their merges are never followed by
 * the delivery chain. The branch is resolved by the same method the listener uses
 * (`AppWorkIsolationService.resolveSourceBranch`: applied spec → tracked branch → Work Repository
 * default) and written through the same ownership-scoped update.
 *
 * ## Not scheduled, and not a migration
 *
 * Nothing triggers this task: running it is an operator's decision, from the Trigger.dev
 * dashboard or CLI. It is a job rather than a migration because the third source reads the git
 * provider. It is idempotent — a Work that already carries a base branch is never visited, so a
 * second run writes nothing — and `{ "dryRun": true }` reports what a run would write without
 * writing it.
 *
 * ## One page per RPC call
 *
 * The runner lives API-side (the git facade and the Work rows are there) and is reached over the
 * internal RPC channel. Each `run()` call visits ONE page (default 25, ceiling 100 Works, each at
 * most one provider read), so no call holds the channel for the whole walk; this task loops on
 * the runner's `nextAfterId` until it answers `done`, bounded by {@link APP_WORK_ISOLATION_BACKFILL_MAX_PAGES} so a cursor
 * that stopped moving can never spin.
 */

/** The task id — the same string `APP_WORK_ISOLATION_BACKFILL_JOB_ID` names on the API side. */
export const APP_WORK_ISOLATION_BACKFILL_TASK_ID = 'app-work-isolation-backfill' as const;

/** The most pages one run walks (× the page size = the most Works one run visits). */
export const APP_WORK_ISOLATION_BACKFILL_MAX_PAGES = 400;

/** What an operator may pass. Everything is optional; `{}` backfills every App Work. */
export interface AppWorkIsolationBackfillTaskPayload {
    /** Resolve and count, write nothing. */
    dryRun?: boolean;
    /** Works per page (1..100, default 25). */
    pageSize?: number;
}

/** The run's totals across every page, plus how it ended. */
export interface AppWorkIsolationBackfillTaskResult {
    status: 'completed' | 'stopped';
    /** `null` when the walk completed; otherwise why it stopped early. */
    reason: string | null;
    pages: number;
    scanned: number;
    updated: number;
    skipped: number;
    unresolved: number;
    failed: number;
    bySource: AppWorkIsolationBackfillSummary['bySource'];
    unresolvedWorkIds: string[];
    failedWorkIds: string[];
    dryRun: boolean;
}

/** How many Work ids the result lists per bucket, so the run record stays small. */
const LISTED_IDS_MAX = 50;

/**
 * The run body, exported so a spec (and a local drain) runs exactly what Trigger runs.
 */
export async function runAppWorkIsolationBackfillTask(
    payload: AppWorkIsolationBackfillTaskPayload = {},
): Promise<AppWorkIsolationBackfillTaskResult> {
    const dryRun = payload?.dryRun === true;
    const limit =
        typeof payload?.pageSize === 'number' && Number.isFinite(payload.pageSize)
            ? payload.pageSize
            : undefined;

    return withWorkerContext(
        'AppWorkIsolationBackfill',
        async (appContext): Promise<AppWorkIsolationBackfillTaskResult> => {
            const runner = appContext.get(AppWorkIsolationBackfillRunner);
            const result: AppWorkIsolationBackfillTaskResult = {
                status: 'completed',
                reason: null,
                pages: 0,
                scanned: 0,
                updated: 0,
                skipped: 0,
                unresolved: 0,
                failed: 0,
                bySource: { spec: 0, tracked: 0, repository: 0 },
                unresolvedWorkIds: [],
                failedWorkIds: [],
                dryRun,
            };

            let afterId: string | null = null;
            let finished = false;
            while (result.pages < APP_WORK_ISOLATION_BACKFILL_MAX_PAGES) {
                const page: AppWorkIsolationBackfillSummary = await runner.run({
                    afterId,
                    dryRun,
                    ...(limit !== undefined ? { limit } : {}),
                });
                result.pages += 1;
                result.scanned += page.scanned;
                result.updated += page.updated;
                result.skipped += page.skipped;
                result.unresolved += page.unresolved;
                result.failed += page.failed;
                for (const source of ['spec', 'tracked', 'repository'] as const) {
                    result.bySource[source] += page.bySource?.[source] ?? 0;
                }
                pushCapped(result.unresolvedWorkIds, page.unresolvedWorkIds);
                pushCapped(result.failedWorkIds, page.failedWorkIds);

                if (page.done) {
                    finished = true;
                    break;
                }
                if (!page.nextAfterId || page.nextAfterId === afterId) {
                    // A page that was not the last must move the cursor; one that did not would
                    // be read again forever.
                    result.status = 'stopped';
                    result.reason = 'cursor_did_not_move';
                    break;
                }
                afterId = page.nextAfterId;
            }
            if (!finished && result.status === 'completed') {
                result.status = 'stopped';
                result.reason = 'page_limit';
            }

            logger.info('app-work-isolation-backfill finished', {
                status: result.status,
                reason: result.reason,
                pages: result.pages,
                scanned: result.scanned,
                updated: result.updated,
                skipped: result.skipped,
                unresolved: result.unresolved,
                failed: result.failed,
                dryRun,
            });
            return result;
        },
        TriggerInternalModule,
    );
}

function pushCapped(into: string[], ids: readonly string[] | undefined): void {
    for (const id of ids ?? []) {
        if (into.length >= LISTED_IDS_MAX) return;
        into.push(id);
    }
}

export const appWorkIsolationBackfillTask = task<
    typeof APP_WORK_ISOLATION_BACKFILL_TASK_ID,
    AppWorkIsolationBackfillTaskPayload
>({
    id: APP_WORK_ISOLATION_BACKFILL_TASK_ID,
    // One-off: a run is a walk over every App Work, each costing at most one provider read.
    maxDuration: 3600,
    run: (payload) => runAppWorkIsolationBackfillTask(payload),
});
