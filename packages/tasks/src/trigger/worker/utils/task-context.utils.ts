import { INestApplicationContext, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { TriggerPluginHydratorService } from '../services/trigger-plugin-hydrator.service';
import { Work, User } from '@ever-works/agent/entities';
// H-22: the payload UUID guard lives in the dependency-free `assert-uuid.utils`
// leaf. Import it from there, never from here: this module pulls in the entity
// barrel and the worker services.
import { assertUuid } from './assert-uuid.utils';

/**
 * Shared bootstrap logic for both generation and import tasks:
 * hydrate plugins, fetch work context, and resolve the orchestrator.
 */
export async function createTaskContext<T>(
    appContext: INestApplicationContext,
    payload: { workId: string; userId: string },
    orchestratorClass: Type<T>,
): Promise<{ user: User; work: Work; orchestrator: T; gitToken?: string }> {
    // H-22: validate at the boundary, BEFORE any value reaches code that
    // builds filesystem paths or DB queries.
    const workId = assertUuid(payload?.workId, 'payload.workId');
    const userId = assertUuid(payload?.userId, 'payload.userId');

    // Initialize plugin system with remote settings
    const hydrator = appContext.get(TriggerPluginHydratorService);
    await hydrator.initialize();

    const apiClient = appContext.get(TriggerInternalApiClient);
    const context = await apiClient.fetchWorkContext(workId, userId);

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
