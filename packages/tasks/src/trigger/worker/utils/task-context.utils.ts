import { INestApplicationContext, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { TriggerPluginHydratorService } from '../services/trigger-plugin-hydrator.service';
import { Work, User } from '@ever-works/agent/entities';

// H-22: any value that flows into a filesystem path component or a SQL
// parameter on the worker side originates here, in the Trigger.dev payload.
// The payload arrives untrusted (Trigger.dev signs delivery but doesn't
// re-validate the body shape), so we re-assert the shape locally before
// handing values to downstream code that builds paths like
// `<BASE_TEMP_DIR>/<userId>/<workId>` (see `getWorkspacePath`). UUID v4 shape
// — adjust if the platform standardises on a different ID format.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new Error(
            `Invalid ${field}: expected a UUID, got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`,
        );
    }
    return value;
}

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
