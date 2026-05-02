import { INestApplicationContext, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { TriggerPluginHydratorService } from '../services/trigger-plugin-hydrator.service';
import { Work, User } from '@ever-works/agent/entities';

/**
 * Shared bootstrap logic for both generation and import tasks:
 * hydrate plugins, fetch work context, and resolve the orchestrator.
 */
export async function createTaskContext<T>(
    appContext: INestApplicationContext,
    payload: { workId: string; userId: string },
    orchestratorClass: Type<T>,
): Promise<{ user: User; work: Work; orchestrator: T; gitToken?: string }> {
    // Initialize plugin system with remote settings
    const hydrator = appContext.get(TriggerPluginHydratorService);
    await hydrator.initialize();

    const apiClient = appContext.get(TriggerInternalApiClient);
    const context = await apiClient.fetchWorkContext(payload.workId, payload.userId);

    const work = plainToInstance(Work, context.work);
    const user = plainToInstance(User, context.user);

    work.user = user;

    const orchestrator = appContext.get(orchestratorClass);

    return {
        user,
        work,
        orchestrator,
        gitToken: context.gitToken,
    };
}
