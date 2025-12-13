import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerWorkerModule } from '../../trigger/trigger-worker.module';
import { TriggerInternalApiClient } from '../../trigger/trigger-internal-api.client';
import { TriggerGenerationOrchestrator } from '../../trigger/trigger-generation.orchestrator';
import { DirectoryGenerationPayload } from '@packages/agent/tasks';
import { Directory, User, GenerateStatusType } from '@packages/agent/entities';
import { RemoteDirectoryScheduleService } from '../../trigger/remote-directory-schedule.service';

async function createContext(
    appContext: INestApplicationContext,
    payload: DirectoryGenerationPayload,
) {
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
    onCancel: async ({ payload }) => {
        if (!payload) {
            return;
        }

        const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
            logger: ['error', 'fatal', 'warn'],
        });

        try {
            const { orchestrator, directory, user } = await createContext(appContext, payload);
            const scheduleService = appContext.get(RemoteDirectoryScheduleService);

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
            logger: ['debug', 'log', 'warn', 'error', 'fatal'],
        });

        try {
            const { orchestrator, directory, user } = await createContext(appContext, payload);
            const scheduleService = appContext.get(RemoteDirectoryScheduleService);

            try {
                await orchestrator.run({
                    directory,
                    user,
                    dto: payload.dto,
                    historyId: payload.historyId,
                    historyStartedAt: payload.historyStartedAt,
                });

                if (payload.triggerSource === 'schedule' && payload.scheduleId) {
                    await scheduleService.markRunCompleted(payload.scheduleId, {
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
