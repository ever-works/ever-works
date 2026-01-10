import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerWorkerModule } from '../../trigger/trigger-worker.module';
import { TriggerInternalApiClient } from '../../trigger/trigger-internal-api.client';
import { TriggerImportOrchestrator } from '../../trigger/trigger-import.orchestrator';
import { DirectoryImportPayload } from '@packages/agent/tasks';
import { Directory, User, GenerateStatusType } from '@packages/agent/entities';
import { TriggerLogger } from '../../trigger/trigger-logger';

async function createContext(appContext: INestApplicationContext, payload: DirectoryImportPayload) {
    const apiClient = appContext.get(TriggerInternalApiClient);
    const context = await apiClient.fetchDirectoryContext(payload.directoryId, payload.userId);

    const directory = plainToInstance(Directory, context.directory);
    const user = plainToInstance(User, context.user);

    directory.user = user;

    const orchestrator = appContext.get(TriggerImportOrchestrator);

    return {
        user,
        directory,
        orchestrator,
    };
}

export const directoryImportTask = task({
    id: 'directory-import',
    maxDuration: 3600 * 2, // 2 hours
    onCancel: async ({ payload }) => {
        if (!payload) {
            return;
        }

        const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
            logger: new TriggerLogger('DirectoryImport:Cancel'),
        });

        try {
            const { orchestrator, directory } = await createContext(appContext, payload);

            await orchestrator.handleCancellation({
                directory,
                historyId: payload.historyId,
                historyStartedAt: payload.historyStartedAt,
            });
        } finally {
            await appContext.close();
        }
    },
    run: async (payload: DirectoryImportPayload) => {
        const appContext = await NestFactory.createApplicationContext(TriggerWorkerModule, {
            logger: new TriggerLogger('DirectoryImport'),
        });

        try {
            const { orchestrator, directory, user } = await createContext(appContext, payload);

            await orchestrator.run({
                directory,
                user,
                payload,
            });

            return {
                status: 'completed',
                directoryId: payload.directoryId,
            };
        } finally {
            await appContext.close();
        }
    },
});
