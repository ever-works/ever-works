import { Injectable, Logger } from '@nestjs/common';
import { TaskRepository } from '@ever-works/agent/tasks-domain';
import type { FleetExecutionScopeQuery } from '@ever-works/contracts';
import type { FleetTaskScopeResolver } from './fleet-agent-task.dispatcher';

/**
 * Task → (Work, Goal) lookup for execution-preference resolution.
 *
 * The dispatch payload carries a `taskId` and nothing about which Work
 * or Goal the Task belongs to, so without this the preference could only
 * ever be account-wide — which is precisely the granularity that already
 * existed via `tenant_job_runtime_config` and precisely the thing the
 * per-Work preference is for.
 *
 * One extra row read on the dispatch path. It is a primary-key lookup
 * against a row the transition service has usually just written, and the
 * alternative (widening `AgentTaskExecuteDispatchPayload` for every
 * runtime, fleet or not) would push a fleet-only concern into a shared
 * contract five other dispatchers implement.
 *
 * Never throws: an unresolvable Task yields an empty scope, which
 * resolves to the account-wide preference. A lookup failure must not be
 * the thing that stops a run.
 */
@Injectable()
export class FleetTaskScopeResolverService implements FleetTaskScopeResolver {
    private readonly logger = new Logger(FleetTaskScopeResolverService.name);

    constructor(private readonly tasks: TaskRepository) {}

    async resolve(taskId: string): Promise<FleetExecutionScopeQuery> {
        if (typeof taskId !== 'string' || !taskId) return {};
        try {
            const task = await this.tasks.findById(taskId);
            if (!task) return {};
            return { workId: task.workId ?? null, goalId: task.goalId ?? null };
        } catch (err) {
            this.logger.debug(
                `Fleet scope lookup failed for task ${taskId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return {};
        }
    }
}
