import { tasks } from '@trigger.dev/sdk';
import type {
    IdeaBuildExecuteDispatcher,
    IdeaBuildExecuteDispatchPayload,
} from '@ever-works/agent/work-agent';
import type { IdeaBuildExecutePayload } from '../tasks/trigger/idea-build-execute.task';

/**
 * PR-4 (domain-model evolution) — production dispatcher adapter that
 * fans a freshly-created Idea-build `WorkAgentGoal` out to the
 * `idea-build-execute` Trigger.dev task.
 *
 * Bound to the `IDEA_BUILD_EXECUTE_DISPATCHER` token by the API-side
 * `IdeaBuildExecutorDispatchModule` (@Global). Keeps `@trigger.dev/sdk`
 * out of the `@ever-works/agent` dependency graph (mirror of
 * `agentTaskExecuteTriggerAdapter`).
 *
 * `idempotencyKey = goalId`: a Goal is executed at most once even if
 * the enqueue double-fires, and the task itself is idempotent (it skips
 * a Goal already in a terminal state).
 */
export const ideaBuildExecuteTriggerAdapter: IdeaBuildExecuteDispatcher = {
    async enqueue(payload: IdeaBuildExecuteDispatchPayload) {
        const handle = await tasks.trigger<
            typeof import('../tasks/trigger/idea-build-execute.task').ideaBuildExecuteTask
        >(
            'idea-build-execute',
            {
                goalId: payload.goalId,
                userId: payload.userId,
                ideaId: payload.ideaId,
            } satisfies IdeaBuildExecutePayload,
            { idempotencyKey: payload.goalId },
        );
        return { handleId: handle.id };
    },
};
