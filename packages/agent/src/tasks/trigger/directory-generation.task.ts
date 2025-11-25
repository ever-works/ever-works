import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerWorkerModule } from '@src/trigger/trigger-worker.module';
import { TriggerInternalApiClient } from '@src/trigger/trigger-internal-api.client';
import { TriggerGenerationOrchestrator } from '@src/trigger/trigger-generation.orchestrator';
import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import { plainToInstance } from 'class-transformer';
import { Directory } from '@src/entities/directory.entity';
import { User } from '@src/entities/user.entity';
import { INestApplicationContext } from '@nestjs/common';
import { DirectoryScheduleService } from '@src/services/directory-schedule.service';
import { GenerateStatusType } from '@src/entities/types';

export const DIRECTORY_GENERATION_MODE = {
    CREATE: 'create',
    UPDATE: 'update',
} as const;

export type DirectoryGenerationMode =
    (typeof DIRECTORY_GENERATION_MODE)[keyof typeof DIRECTORY_GENERATION_MODE];

export type DirectoryGenerationPayload = {
    directoryId: string;
    userId: string;
    mode: DirectoryGenerationMode;
    dto: CreateItemsGeneratorDto;
    historyId: string;
    historyStartedAt?: string;
    triggerSource?: 'user' | 'schedule' | 'api';
    scheduleId?: string;
};

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
            logger: ['debug', 'log', 'warn', 'error', 'fatal'],
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
