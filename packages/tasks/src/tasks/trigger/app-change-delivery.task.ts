import { logger, schedules } from '@trigger.dev/sdk';
import { TaskDeliveryService } from '@ever-works/agent/tasks-domain';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * APW-08 T23 — the `app-change-delivery` schedule (plan §6): follows every merged App Work change
 * until a Build and a Deployment that contain it are live, then closes its Task; opens the
 * follow-up Task of a change that failed to build or deploy (spec FR-29…FR-40).
 *
 * Every two minutes on the ODD minute (`1-59/2`), one minute after `task-pr-status-sync`
 * (`*\/2`), so a merge that sweep records on an even minute is reconciled on the next odd one.
 * The tick calls the API-side `TaskDeliveryService.reconcile({ limit })` over the internal RPC
 * channel — the git-provider plugins (commit ancestry) and the Build / Deployment rows live there.
 * That one call is per-Task isolated (one Task's error is counted, never thrown), so a bad row can
 * never abort the tick, and it is idempotent: each decision is a pure function of the current rows.
 *
 * ## Batch and switches
 *
 * `APP_CHANGE_DELIVERY_BATCH` overrides the batch (default and ceiling 200, plan §6). The
 * operator's `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` switch is read by the service ITSELF at each
 * decision (T49: "each dispatcher reads the switch itself") — off, the chain keeps its states
 * honest but opens no follow-up.
 */

/** Plan §6 — two minutes, offset one minute from `task-pr-status-sync`. */
export const APP_CHANGE_DELIVERY_CRON = '1-59/2 * * * *';

/** Plan §6 — Tasks reconciled per tick (also the ceiling). */
export const APP_CHANGE_DELIVERY_BATCH = 200;

/** `APP_CHANGE_DELIVERY_BATCH` when it is an integer 1..200, else the default. */
export function resolveAppChangeDeliveryBatch(
    raw: string | undefined = process.env.APP_CHANGE_DELIVERY_BATCH,
): number {
    const value = Number((raw ?? '').trim());
    if (!Number.isInteger(value) || value < 1) return APP_CHANGE_DELIVERY_BATCH;
    return Math.min(value, APP_CHANGE_DELIVERY_BATCH);
}

export const appChangeDeliveryTask = schedules.task({
    id: 'app-change-delivery',
    cron: APP_CHANGE_DELIVERY_CRON,
    run: async () => {
        return withWorkerContext(
            'AppChangeDelivery',
            async (appContext) => {
                const svc = appContext.get(TaskDeliveryService);
                const limit = resolveAppChangeDeliveryBatch();
                const summary = await svc.reconcile({ limit });
                if (summary.scanned > 0 || summary.failed > 0) {
                    logger.info('app-change-delivery reconciled merged App Work changes', {
                        ...summary,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
