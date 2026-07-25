import { logger, schedules } from '@trigger.dev/sdk';
import { DigestService } from '@ever-works/agent/digest';
import type { DigestDispatchSummary } from '@ever-works/agent/digest';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Digest briefings (Wave 7) — morning dispatcher.
 *
 * Every day at 07:15 UTC, deliver the daily digests; on Mondays the
 * weekly digests ride the same run (a single schedule with an
 * in-task weekday check keeps the cadence single-sourced instead of
 * two crons that can drift apart).
 *
 * The real `DigestService` lives in the API (repositories + the
 * notifications producer + channel fanout are wired there); the
 * worker only calls `dispatchDue(period)` over the internal RPC
 * channel — same shape as the event-ingest-tick / mission-tick
 * crons. Per-user preference gating, quiet-period skips, and the
 * per-window dedup key all live in the service, so a re-run of this
 * task is safe.
 */
export const digestDispatcherTask = schedules.task({
    id: 'digest-dispatcher',
    cron: '15 7 * * *',
    run: async () => {
        return withWorkerContext(
            'DigestDispatcher',
            async (appContext) => {
                const svc = appContext.get(DigestService);

                const daily = await svc.dispatchDue('daily');
                logger.info('digest-dispatcher daily pass', { ...daily });

                let weekly: DigestDispatchSummary | null = null;
                if (new Date().getUTCDay() === 1) {
                    weekly = await svc.dispatchDue('weekly');
                    logger.info('digest-dispatcher weekly pass', { ...weekly });
                }

                return { daily, weekly };
            },
            TriggerInternalModule,
        );
    },
});
