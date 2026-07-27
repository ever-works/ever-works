import { logger, schedules } from '@trigger.dev/sdk';
import { DigestService } from '@ever-works/agent/digest';
import type { DigestDispatchSummary, OrgDigestDispatchSummary } from '@ever-works/agent/digest';
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
 * Each pass runs TWICE: once over users (`dispatchDue`) and once over
 * opted-in organizations (`dispatchDueOrganizations`). The two are
 * independent — an org pass never suppresses or consumes a member's
 * personal digest, and an org that never opted in is never scanned —
 * so adding the org pass changes nothing for existing installs.
 *
 * The real `DigestService` lives in the API (repositories + the
 * notifications producer + channel fanout are wired there); the
 * worker only calls into it over the internal RPC channel — same
 * shape as the event-ingest-tick / mission-tick crons. Preference
 * gating, quiet-period skips, and the per-window dedup key all live
 * in the service, so a re-run of this task is safe.
 *
 * An org pass failure is caught and logged rather than allowed to fail
 * the run: the per-user digests are the older, load-bearing half and
 * must not be lost to a fault in the newer one.
 */
export const digestDispatcherTask = schedules.task({
    id: 'digest-dispatcher',
    cron: '15 7 * * *',
    run: async () => {
        return withWorkerContext(
            'DigestDispatcher',
            async (appContext) => {
                const svc = appContext.get(DigestService);

                const dispatchOrgs = async (
                    period: 'daily' | 'weekly',
                ): Promise<OrgDigestDispatchSummary | null> => {
                    try {
                        const summary = await svc.dispatchDueOrganizations(period);
                        logger.info(`digest-dispatcher ${period} organization pass`, {
                            ...summary,
                        });
                        return summary;
                    } catch (error) {
                        logger.error(`digest-dispatcher ${period} organization pass failed`, {
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return null;
                    }
                };

                const daily = await svc.dispatchDue('daily');
                logger.info('digest-dispatcher daily pass', { ...daily });
                const dailyOrgs = await dispatchOrgs('daily');

                let weekly: DigestDispatchSummary | null = null;
                let weeklyOrgs: OrgDigestDispatchSummary | null = null;
                if (new Date().getUTCDay() === 1) {
                    weekly = await svc.dispatchDue('weekly');
                    logger.info('digest-dispatcher weekly pass', { ...weekly });
                    weeklyOrgs = await dispatchOrgs('weekly');
                }

                return { daily, dailyOrgs, weekly, weeklyOrgs };
            },
            TriggerInternalModule,
        );
    },
});
