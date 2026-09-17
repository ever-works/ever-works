import { logger, schedules } from '@trigger.dev/sdk';
import { ModelAccountHealthService } from '@ever-works/agent/model-routing';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Model accounts (AW-16) — the periodic credential health check.
 *
 * Every six hours, every enabled Model Account not checked in the last six
 * hours is checked with its provider's own identity check (or its connection
 * test when the provider declares none). An account whose known expiry is
 * within 14 days becomes `expiring`; one the provider refuses becomes
 * `invalid`; a check that cannot run leaves it `unknown`. A check never
 * changes an account's position and never fails a Run.
 *
 * Each account is claimed atomically before it is probed
 * (`claimForCheck`), so an overlapping tick — a slow run, a redeploy — probes
 * nothing twice. The work runs in the API through the internal RPC proxy,
 * because that is where the provider plugins are loaded.
 *
 * Cron offset off the hour, per the `kb-reconcile` rationale, so it does not
 * collide with the per-minute crons or the other sweeps (`agent-run-sweeper`
 * at minute 23, `workflow-run-sweeper` at minute 37).
 */
export const modelAccountHealthTask = schedules.task({
    id: 'model-account-health',
    cron: '19 */6 * * *',
    run: async () => {
        // NOTE the third argument. `withWorkerContext` defaults to
        // `TriggerWorkerModule`, which does NOT register the
        // ModelAccountHealthService remote proxy — omitting it fails at
        // runtime on every fire, silently.
        return withWorkerContext(
            'ModelAccountHealth',
            async (appContext) => {
                const health = appContext.get(ModelAccountHealthService);
                const sweep = await health.probeDueAccounts();
                if (sweep.checked > 0) {
                    logger.info('model-account-health checked accounts', { ...sweep });
                }
                return { status: 'completed' as const, ...sweep };
            },
            TriggerInternalModule,
        );
    },
});
