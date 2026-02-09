import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerWorkerModule } from '../../trigger/worker/modules/trigger-worker.module';
import { TriggerInternalApiClient } from '../../trigger/worker/services/trigger-internal-api.client';
import { TriggerImportOrchestrator } from '../../trigger/worker/orchestrators/trigger-import.orchestrator';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { DirectoryImportPayload } from '@ever-works/agent/tasks';
import { Directory, User } from '@ever-works/agent/entities';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

async function createContext(appContext: INestApplicationContext, payload: DirectoryImportPayload) {
    // Initialize plugin system with remote settings
    const hydrator = appContext.get(TriggerPluginHydratorService);
    await hydrator.initialize();

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
        gitToken: context.gitToken,
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
            logger: createTriggerLogger('DirectoryImport:Cancel'),
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
            logger: createTriggerLogger('DirectoryImport'),
        });

        try {
            const { orchestrator, directory, user, gitToken } = await createContext(
                appContext,
                payload,
            );

            await orchestrator.run({
                directory,
                user,
                payload,
                gitToken,
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
