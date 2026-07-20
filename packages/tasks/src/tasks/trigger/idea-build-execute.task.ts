import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { IdeaBuildExecutorService } from '@ever-works/agent/work-agent';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
// Security: validate Trigger.dev payload IDs before any DB access
// (defense-in-depth, mirrors agent-task-execute).
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

export interface IdeaBuildExecutePayload {
    /** The Idea-build `WorkAgentGoal` to execute. */
    goalId: string;
    /** Owner scope — every executor DB access is scoped to this. */
    userId: string;
    /** The Idea (`WorkProposal`) the Goal is building. */
    ideaId: string;
}

/**
 * PR-4 (domain-model evolution) — the Idea → Work build executor task.
 *
 * One-shot Trigger.dev task enqueued (by the API build/retry/rebuild
 * path and by Mission auto-build) ONLY when
 * `EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED=true`. When the flag is off
 * this task is never triggered, so merging this PR changes nothing in
 * production.
 *
 * The task is intentionally thin: it boots the worker app-context and
 * resolves `IdeaBuildExecutorService` over the internal RPC channel
 * (remote-proxy pattern, same as `mission-tick`), so the actual
 * state-machine logic runs in the fully-wired API process where
 * `WorkProposalService` + repositories live. The service:
 *   - auto-approves the Goal (WAITING_FOR_APPROVAL → RUNNING),
 *   - marks the Idea BUILDING,
 *   - and in DRY-RUN mode (default) synthesizes a deterministic outcome
 *     and drives `handleGoalCompletion` — accept / retry / failed —
 *     WITHOUT generating a real Work (zero AI/deploy spend).
 *
 * `maxDuration` mirrors `agent-task-execute` (60 min) — the dry-run
 * path is fast, and the ceiling leaves headroom for the real
 * generation path when it eventually lands.
 */
export const ideaBuildExecuteTask = task<'idea-build-execute', IdeaBuildExecutePayload>({
    id: 'idea-build-execute',
    maxDuration: 3600,
    run: async (payload: IdeaBuildExecutePayload) => {
        assertUuid(payload.goalId, 'payload.goalId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.ideaId, 'payload.ideaId');

        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('IdeaBuildExecute'));

        try {
            const executor = appContext.get(IdeaBuildExecutorService);
            return await executor.executeBuild({
                goalId: payload.goalId,
                userId: payload.userId,
                ideaId: payload.ideaId,
            });
        } finally {
            await appContext.close();
        }
    },
});
