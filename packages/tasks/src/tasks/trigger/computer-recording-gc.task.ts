import { logger, schedules } from '@trigger.dev/sdk';
import { DesktopRecordingService } from '@ever-works/agent/computer';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Nightly at 03:23 UTC. A literal, read at module load where Trigger.dev
 * indexes it; it equals the shared `FLEET_DESKTOP_RECORDING_GC_CRON` in
 * `@ever-works/contracts` the API fallback cron uses.
 */
export const COMPUTER_RECORDING_GC_CRON = '23 3 * * *';

/**
 * Desktop view & control (FL-07 P2.C, T-40, FR-52) — the recording retention
 * sweep.
 *
 * Every Desktop-view recording past its `recordingExpiresAt` (14 days after
 * the view ended by default; the computer's `recordingRetentionDays`, clamped
 * 1–90) is deleted: every stored object first, the row's recording fields
 * second, so a failed object delete leaves the row for the next night.
 * Nothing is ever deleted on read.
 *
 * The real `DesktopRecordingService` lives in the API (the storage plugin and
 * the rows are wired there); the worker reaches its one-member facade
 * (`sweepExpired()`) over the internal RPC channel — the shape of
 * `fleet-session-sweeper`. When Trigger.dev is not the runtime the API runs
 * the same pass itself (`FleetDesktopRecordingGcCronService`).
 */
export const computerRecordingGcTask = schedules.task({
    id: 'computer-recording-gc',
    cron: COMPUTER_RECORDING_GC_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the DesktopRecordingService remote proxy.
        return withWorkerContext(
            'ComputerRecordingGc',
            async (appContext) => {
                const svc = appContext.get(DesktopRecordingService);
                const summary = await svc.sweepExpired();
                if (summary.deleted > 0 || summary.failed > 0) {
                    logger.info('computer-recording-gc pruned expired desktop recordings', { ...summary });
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
