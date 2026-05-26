import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export interface AgentTaskExecutePayload {
    agentId: string;
    userId: string;
    taskId: string;
    /** Deduplication key — `${taskId}:${agentId}:${generation}`. */
    dedupKey: string;
}

/**
 * Tasks feature — Phase 15.1.
 *
 * One-shot Trigger.dev task that executes an Agent-on-Task run.
 * Dispatched by `TaskTransitionService` on `* → in_progress` when
 * any Agent assignee is present (dedup by `(taskId, agentId,
 * generation)` so a rapid in_progress → in_review → in_progress
 * flip doesn't double-fire).
 *
 * v1 is a placeholder — wires the queued AgentRun row + marks it
 * started + completed with a stub summary, then releases. The real
 * orchestrator (`AgentRunService.execute` with kind='task'`) plumbs
 * once the LLM dispatch path lands. Status carries through to the
 * UI via the AgentRun row + AGENT_HEARTBEAT_* activity events.
 *
 * maxDuration = 60min per `features/task-tracking/plan.md §15`.
 */
export const agentTaskExecuteTask = task<'agent-task-execute', AgentTaskExecutePayload>({
    id: 'agent-task-execute',
    maxDuration: 3600,
    onFailure: async ({ payload, error }) => {
        if (!payload) return;
        try {
            const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
            appContext.useLogger(createTriggerLogger('AgentTaskExecute:Failure'));
            try {
                const runs = appContext.get(AgentRunRepository);
                const message = error instanceof Error ? error.message : String(error);
                const inFlight = await runs.findInFlightForAgent(payload.agentId);
                if (inFlight) {
                    await runs.markFailed(inFlight.id, message);
                }
            } finally {
                await appContext.close();
            }
        } catch {
            // Best-effort — stuck-row sweep will recover.
        }
    },
    run: async (payload: AgentTaskExecutePayload) => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentTaskExecute'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);

            const agent = await agents.findById(payload.agentId);
            if (!agent) {
                return { status: 'skipped', reason: 'agent-not-found', agentId: payload.agentId };
            }

            // Look up the dispatcher-queued in-flight run (created when
            // TaskTransitionService fanned out the dispatch). If we
            // don't find one, create on the fly so the audit trail is
            // consistent.
            let run = await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
            if (!run) {
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: agent.userId,
                    triggerKind: 'task',
                    taskId: payload.taskId,
                });
            }

            await runs.markStarted(run.id, null);

            // Phase 15 placeholder — Phase 7's AgentRunService.execute()
            // with kind='task' wires the real prompt-assembly + LLM
            // dispatch + tool loop once Skill catalog + tools land. v1
            // marks the run completed with a stub summary so the
            // status flow + Activity Feed entries fire end-to-end.
            const summary = `Phase 15 placeholder — task ${payload.taskId} acknowledged by Agent ${agent.id}`;
            await runs.markCompleted(run.id, summary);

            return {
                status: 'completed',
                agentId: agent.id,
                taskId: payload.taskId,
                runId: run.id,
                dedupKey: payload.dedupKey,
            };
        } finally {
            await appContext.close();
        }
    },
});
