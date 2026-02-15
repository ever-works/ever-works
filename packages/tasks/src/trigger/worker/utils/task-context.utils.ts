import { INestApplicationContext, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { TriggerPluginHydratorService } from '../services/trigger-plugin-hydrator.service';
import { Directory, User } from '@ever-works/agent/entities';

/**
 * Shared bootstrap logic for both generation and import tasks:
 * hydrate plugins, fetch directory context, and resolve the orchestrator.
 */
export async function createTaskContext<T>(
    appContext: INestApplicationContext,
    payload: { directoryId: string; userId: string },
    orchestratorClass: Type<T>,
): Promise<{ user: User; directory: Directory; orchestrator: T; gitToken?: string }> {
    // Initialize plugin system with remote settings
    const hydrator = appContext.get(TriggerPluginHydratorService);
    await hydrator.initialize();

    const apiClient = appContext.get(TriggerInternalApiClient);
    const context = await apiClient.fetchDirectoryContext(payload.directoryId, payload.userId);

    const directory = plainToInstance(Directory, context.directory);
    const user = plainToInstance(User, context.user);

    directory.user = user;

    const orchestrator = appContext.get(orchestratorClass);

    return {
        user,
        directory,
        orchestrator,
        gitToken: context.gitToken,
    };
}
