import { task } from '@trigger.dev/sdk';
import { DirectoryGenerationPayload } from '@ever-works/agent/tasks';
import { GenerateStatusType } from '@ever-works/agent/entities';
import {
    DirectoryScheduleService,
    normalizeGeneratorError,
} from '@ever-works/agent/services';
import { TriggerGenerationOrchestrator } from '../../trigger/worker/orchestrators/trigger-generation.orchestrator';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { createTaskContext } from '../../trigger/worker/utils/task-context.utils';

export const directoryGenerationTask = task({
    id: 'directory-generation',
    maxDuration: 3600 * 5, // 5 hours
    onFailure: async ({ payload, error }) => {
        if (!payload) {
            return;
        }

        try {
            await withWorkerContext('DirectoryGeneration:Failure', async (appContext) => {
                const { orchestrator, directory } = await createTaskContext(
                    appContext,
                    payload,
                    TriggerGenerationOrchestrator,
                );
                const scheduleService = appContext.get(DirectoryScheduleService);

                const errorMessage = normalizeGeneratorError(error);

                await orchestrator.handleFailure({
                    directory,
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
            await withWorkerContext('DirectoryGeneration:Cancel', async (appContext) => {
                const { orchestrator, directory } = await createTaskContext(
                    appContext,
                    payload,
                    TriggerGenerationOrchestrator,
                );
                const scheduleService = appContext.get(DirectoryScheduleService);

                await orchestrator.handleCancellation({
                    directory,
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
    run: async (payload: DirectoryGenerationPayload) => {
        return withWorkerContext('DirectoryGeneration', async (appContext) => {
            const { orchestrator, directory, user } = await createTaskContext(
                appContext,
                payload,
                TriggerGenerationOrchestrator,
            );
            const scheduleService = appContext.get(DirectoryScheduleService);

            try {
                await orchestrator.run({
                    directory,
                    user,
                    dto: payload.dto,
                    historyId: payload.historyId,
                    historyStartedAt: payload.historyStartedAt,
                });

                if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                    await scheduleService.markRunCompleted({
                        scheduleId: payload.scheduleId,
                        historyId: payload.historyId,
                        status: GenerateStatusType.GENERATED,
                    });
                }
            } catch (error) {
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
                directoryId: payload.directoryId,
            };
        });
    },
});
