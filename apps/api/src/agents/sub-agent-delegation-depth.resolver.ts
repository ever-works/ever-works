import { Injectable, Logger } from '@nestjs/common';
import type { SubAgentDelegationRequest } from '@ever-works/contracts';
import type { SubAgentDelegationDepthResolver } from '@ever-works/agent/agents';
import { AgentRunRepository } from '@ever-works/agent/database';
// `TaskRepository` is re-exported from the tasks-domain barrel, not the
// database one — importing it from `@ever-works/agent/database` compiles
// against nothing and breaks the API build.
import { TaskRepository } from '@ever-works/agent/tasks-domain';

/**
 * Server-derived sub-agent delegation depth (judgment layer G9).
 *
 * `validateSubAgentDelegationRequest` refuses a delegation once
 * `depth >= SUB_AGENT_MAX_DELEGATION_DEPTH`, but the depth it checks is
 * DECLARED BY THE CALLER. Nothing in the platform ever set it above 0,
 * so the ceiling could not fire and unbounded delegation chains were
 * held back only by `TasksService.create`'s parent-chain limit of 64 —
 * two orders of magnitude past the intended bound, and only when the
 * caller happened to thread `parentTaskId`.
 *
 * This resolver reads the number the platform wrote itself instead.
 * Every delegated child IS a Task row that
 * `SubAgentDelegationRunnerService` stamped with `parent + 1`, so:
 *
 *   depth of the delegation being issued
 *     = `delegationDepth` of the Task whose run is issuing it
 *
 * ## Resolution order
 *
 *  1. `parentTaskId` — the direct answer, one primary-key read.
 *  2. `parentRunId` → `AgentRun.taskId` → that Task. Covers a caller that
 *     threads the run but not the task.
 *  3. `null` — unresolvable. The declared depth stands, which is no
 *     weaker than today.
 *
 * ## Why the unscoped read is acceptable here
 *
 * `TaskRepository.findById` is not user-scoped, and this resolver has no
 * `userId` to scope with (`SubAgentDelegationService` is deliberately
 * runtime-free). The mitigation is that NOTHING but the integer leaves
 * this class: no title, no ids, no existence signal reaches the caller —
 * a wrong guess yields a number that can only ever make the caller's own
 * delegation MORE restricted. That is the entire observable surface.
 */
@Injectable()
export class SubAgentDelegationDepthResolverService implements SubAgentDelegationDepthResolver {
    private readonly logger = new Logger(SubAgentDelegationDepthResolverService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly runs: AgentRunRepository,
    ) {}

    async resolveDepth(request: SubAgentDelegationRequest): Promise<number | null> {
        try {
            const taskId = await this.resolveParentTaskId(request);
            if (!taskId) return null;

            const task = await this.tasks.findById(taskId);
            if (!task) return null;

            const depth = task.delegationDepth;
            // `null` is the honest answer for "not delegated" (every
            // human-filed Task, and every row predating the column), and
            // that reads as depth 0 — NOT as unresolvable, because 0 is a
            // real, correct depth for a root Task.
            if (depth === null || depth === undefined) return 0;
            return Number.isInteger(depth) && depth >= 0 ? depth : 0;
        } catch (err) {
            // Never throw: a lookup outage must not turn a delegation into
            // an error. The declared depth stands.
            this.logger.debug(
                `Could not resolve delegation depth for ${request?.delegationId}: ` +
                    `${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        }
    }

    private async resolveParentTaskId(request: SubAgentDelegationRequest): Promise<string | null> {
        if (request?.parentTaskId) return request.parentTaskId;
        if (!request?.parentRunId) return null;

        const run = await this.runs.findById(request.parentRunId);
        return run?.taskId ?? null;
    }
}
