import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerWorkerModule } from '../../trigger/worker/modules/trigger-worker.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { TriggerGenerationOrchestrator } from '../../trigger/worker/orchestrators/trigger-generation.orchestrator';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { DirectoryGenerationPayload } from '@ever-works/agent/tasks';
import { Directory, User, GenerateStatusType } from '@ever-works/agent/entities';
import { DirectoryScheduleService } from '@ever-works/agent/services';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

async function createContext(
    appContext: INestApplicationContext,
    payload: DirectoryGenerationPayload,
) {
    // Initialize plugin system with remote settings
    const hydrator = appContext.get(TriggerPluginHydratorService);
    await hydrator.initialize();

    const apiClient = appContext.get(TriggerInternalApiClient);
    const context = await apiClient.fetchDirectoryContext(payload.directoryId, payload.userId);

    const directory = plainToInstance(Directory, context.directory);
    const user = plainToInstance(User, context.user);

    directory.user = user;

    const orchestrator = appContext.get(TriggerGenerationOrchestrator);

    return {
        user,
        directory,
        orchestrator,
    };
}

export const directoryGenerationTask = task({
    id: 'directory-generation',
    maxDuration: 3600 * 5, // 5 hours
    onCancel: async ({ payload }) => {
        if (!payload) {
            return;
        }

        const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
            logger: createTriggerLogger('DirectoryGeneration:Cancel'),
        });

        try {
            const { orchestrator, directory, user } = await createContext(appContext, payload);
            const scheduleService = appContext.get(DirectoryScheduleService);

            await orchestrator.handleCancellation({
                directory,
                user,
                dto: payload.dto,
                historyId: payload.historyId,
                historyStartedAt: payload.historyStartedAt,
            });

            if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                await scheduleService.markRunFailed(payload.scheduleId, 'cancelled');
            }
        } finally {
            await appContext.close();
        }
    },
    run: async (payload: DirectoryGenerationPayload) => {
        const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
            logger: createTriggerLogger('DirectoryGeneration'),
        });

        try {
            const { orchestrator, directory, user } = await createContext(appContext, payload);
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
        } finally {
            await appContext.close();
        }
    },
});
