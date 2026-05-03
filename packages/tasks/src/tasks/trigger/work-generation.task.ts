import { task } from '@trigger.dev/sdk';
import { WorkGenerationPayload } from '@ever-works/agent/tasks';
import { GenerateStatusType } from '@ever-works/agent/entities';
import { WorkScheduleService, normalizeGeneratorError } from '@ever-works/agent/services';
import { TriggerGenerationOrchestrator } from '../../trigger/worker/orchestrators/trigger-generation.orchestrator';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { createTaskContext } from '../../trigger/worker/utils/task-context.utils';

export const workGenerationTask = task<'work-generation', WorkGenerationPayload>({
    id: 'work-generation',
    maxDuration: 3600 * 5, // 5 hours
    onFailure: async ({ payload, error }) => {
        if (!payload) {
            return;
        }

        try {
            await withWorkerContext('WorkGeneration:Failure', async (appContext) => {
                const { orchestrator, work } = await createTaskContext(
                    appContext,
                    payload,
                    TriggerGenerationOrchestrator,
                );
                const scheduleService = appContext.get(WorkScheduleService);

                const errorMessage = normalizeGeneratorError(error);

                await orchestrator.handleFailure({
                    work,
                    historyId: payload.historyId,
                    historyStartedAt: payload.historyStartedAt,
                    errorMessage,
                });

                if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                    await scheduleService.markRunFailed(payload.scheduleId, errorMessage);
                }
            });
        } catch {
            // Best-effort — if we can't even boot the context, nothing more we can do
        }
    },
    onCancel: async ({ payload }) => {
        if (!payload) {
            return;
        }

        try {
            await withWorkerContext('WorkGeneration:Cancel', async (appContext) => {
                const { orchestrator, work } = await createTaskContext(
                    appContext,
                    payload,
                    TriggerGenerationOrchestrator,
                );
                const scheduleService = appContext.get(WorkScheduleService);

                await orchestrator.handleCancellation({
                    work,
                    historyId: payload.historyId,
                    historyStartedAt: payload.historyStartedAt,
                });

                if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                    await scheduleService.markRunFailed(payload.scheduleId, 'cancelled');
                }
            });
        } catch {
            // Best-effort — if we can't boot the context, nothing more we can do
        }
    },
    run: async (payload: WorkGenerationPayload, { signal }) => {
        return withWorkerContext('WorkGeneration', async (appContext) => {
            const { orchestrator, work, user } = await createTaskContext(
                appContext,
                payload,
                TriggerGenerationOrchestrator,
            );
            const scheduleService = appContext.get(WorkScheduleService);

            try {
                const finalStatus = await orchestrator.run({
                    work,
                    user,
                    dto: payload.dto,
                    historyId: payload.historyId,
                    historyStartedAt: payload.historyStartedAt,
                    signal,
                });

                if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                    if (finalStatus === GenerateStatusType.CANCELLED) {
                        await scheduleService.markRunFailed(payload.scheduleId, 'cancelled');
                    } else {
                        await scheduleService.markRunCompleted({
                            scheduleId: payload.scheduleId,
                            historyId: payload.historyId,
                            status: GenerateStatusType.GENERATED,
                        });
                    }
                }
            } catch (error) {
                // Mark schedule as failed. The onFailure handler also calls markRunFailed,
                // but markRunFailed is idempotent so the duplicate call is harmless.
                if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                    await scheduleService.markRunFailed(
                        payload.scheduleId,
                        (error as Error)?.message,
                    );
                }
                throw error;
            }

            return {
                status: 'completed',
                workId: payload.workId,
            };
        });
    },
});
