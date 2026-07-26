import { logger, schedules } from '@trigger.dev/sdk';
import { TaskPrStatusService } from '@ever-works/agent/tasks-domain';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * PR status sync (kanban run cockpit, plan 04 M5 + the merged half of M7).
 *
 * Refreshes the cached `prState` / `ciState` on Tasks whose pull request
 * is still OPEN and whose verdict has gone stale, and lands the ones that
 * merged (`prState=merged` → the Task completes, subject to the approver
 * gate — see `TaskPrStatusService.completeOnMerge`).
 *
 * Why a cron rather than a webhook: the board must be honest for every
 * connected provider, including installs whose webhook was never
 * configured or has been silently failing. Provider webhooks are the
 * follow-up that makes this a FALLBACK, not a replacement — the reference
 * lesson (plan 04 §4.5) is that the poll stays even after push lands,
 * because drift self-heals on the next tick.
 *
 * Rate posture: every-2-minutes, a bounded batch per tick
 * (`PR_STATUS_SYNC_BATCH`), stalest-first ordering, and terminal PRs
 * excluded from the scan predicate forever. The throttle lives in the
 * service + the repository query, not here, so the on-demand endpoint
 * shares exactly the same budget.
 */
export const taskPrStatusSyncTask = schedules.task({
    id: 'task-pr-status-sync',
    cron: '*/2 * * * *',
    run: async () => {
        return withWorkerContext(
            'TaskPrStatusSync',
            async (appContext) => {
                const svc = appContext.get(TaskPrStatusService);
                const limit = Number(process.env.TASK_PR_STATUS_SYNC_BATCH) || undefined;
                const staleSeconds =
                    Number(process.env.TASK_PR_STATUS_SYNC_STALE_SECONDS) || undefined;
                const summary = await svc.syncDuePrStatuses({ limit, staleSeconds });
                if (summary.refreshed > 0 || summary.failed > 0) {
                    logger.info('task-pr-status-sync refreshed pull-request status', {
                        ...summary,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
