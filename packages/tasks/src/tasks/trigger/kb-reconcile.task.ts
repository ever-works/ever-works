import { logger, schedules } from '@trigger.dev/sdk';
import { KnowledgeBaseReconcileService } from '@ever-works/agent/services';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-643 Phase 3 slice 4a — daily Knowledge Base reconciliation sweep.
 *
 * Runs once per day (03:42 UTC — deliberately offset from the
 * `anonymous-user-cleanup` (03:17 UTC) and `data-repo-sync-dispatcher`
 * (every minute) schedules so the three crons don't all hit the
 * database in the same second). The body delegates to
 * `KnowledgeBaseReconcileService.reconcile()` which:
 *
 *   1. Flips uploads stuck in `extractionStatus='running'` for longer
 *      than `KB_RECONCILE_STALE_AFTER_MS` (default 24h) to `failed`.
 *   2. Scans the storage backend's `kb-originals/` prefix and *logs*
 *      any object key that no live upload row references (no delete in
 *      this slice — an operator decides whether to GC).
 *   3. Emits a typed `kb.reconcile.completed` PostHog event with
 *      hit-count counters; the privacy guard inside `emitKbEvent`
 *      strips body-shaped fields if anyone tries to add them.
 *
 * Trigger.dev's `schedules.task` doesn't accept custom run payloads —
 * the SDK shape passes a fixed `{ timestamp, lastTimestamp, externalId,
 * upcoming }`. The `workId?` operator knob is therefore threaded
 * through the optional `externalId` field: scheduling the task with an
 * `externalId` narrows the sweep to that single Work, while the
 * default cron firing (no externalId) sweeps everything.
 */
export const kbReconcileTask = schedules.task({
    id: 'kb-reconcile',
    cron: '42 3 * * *',
    run: async (payload) => {
        return withWorkerContext('KbReconcile', async (appContext) => {
            const svc = appContext.get(KnowledgeBaseReconcileService);
            const workId = payload.externalId ?? undefined;
            logger.info('kb-reconcile starting', { workId });

            const summary = await svc.reconcile({ workId });

            logger.info('kb-reconcile completed', {
                workId,
                staleUploads: summary.staleUploads,
                orphanedObjects: summary.orphanedObjects,
            });

            return {
                status: 'completed' as const,
                workId,
                staleUploads: summary.staleUploads,
                orphanedObjects: summary.orphanedObjects,
            };
        });
    },
});
