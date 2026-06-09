import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { AgentRunService } from '@ever-works/agent/agents';
import { TasksService } from '@ever-works/agent/tasks-domain';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * Security (prompt-injection hardening): chat-template control markers that
 * some models treat as out-of-band role/turn delimiters. Mirrors the
 * `CHAT_TEMPLATE_MARKER_PATTERN` shared by the prompt assembler
 * (`@ever-works/agent` `prompt-assembler.service.ts`
 * `neutralizeInjectedBlock`) and the standard pipeline's prompt utils.
 */
const CHAT_TEMPLATE_MARKER_PATTERN =
    /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi;

/**
 * Security (prompt-injection hardening): `taskRow.title` / `taskRow.description`
 * are attacker-controlled for inbound-email-spawned Tasks (the email subject /
 * body land verbatim in those fields). They are interpolated into
 * `immediateInput`, the single user message that drives the agent's tool loop,
 * so a crafted title/description containing a chat-template control marker
 * (e.g. `<|im_start|>system`) could spoof a system/user turn and nudge tool
 * use. Strip those control tokens before the field enters the prompt. This is
 * a pure mechanical strip — newlines, whitespace, and all benign content pass
 * through unchanged, so legitimate Task fields are unaffected; only the
 * forgeable control markers are defused.
 */
function neutralizeControlTokens(value: string): string {
    return value.replace(CHAT_TEMPLATE_MARKER_PATTERN, '');
}

export interface AgentTaskExecutePayload {
    agentId: string;
    userId: string;
    taskId: string;
    runId?: string;
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
                const inFlight = payload.runId
                    ? await runs.findById(payload.runId)
                    : await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
                if (inFlight && (inFlight.status === 'queued' || inFlight.status === 'running')) {
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
            const runner = appContext.get(AgentRunService);
            const tasks = appContext.get(TasksService);

            // Security: scope the Agent lookup to the payload's userId
            // (defense-in-depth IDOR guard). The legitimate dispatch path
            // (`TaskTransitionService.fanOutAgentExecutions`) always derives
            // `agentId` from an assignee of a task the `userId` owns, so this
            // never rejects a real run — but if the Trigger.dev payload is
            // forged with another tenant's `agentId`, `findByIdAndUser`
            // returns null and we skip instead of executing a cross-tenant
            // Agent. Mirrors `AgentRunRepository.findByIdAndUser` ownership
            // posture (architecture/security §9, no-existence-leak).
            const agent = await agents.findByIdAndUser(payload.agentId, payload.userId);
            if (!agent) {
                // Security: do not echo the caller-supplied `agentId` back in
                // the skip response — it would reflect a (possibly forged /
                // cross-tenant) UUID into the persisted Trigger.dev run record
                // and act as an existence oracle for dashboard-scoped viewers.
                return { status: 'skipped', reason: 'agent-not-found' };
            }

            // Security: scope the Task lookup to the payload's userId before
            // we link/create any AgentRun row (IDOR guard). `getOne` resolves
            // via `TaskRepository.findByIdAndUser` and throws an
            // existence-leak-safe 404 for a foreign/non-owned `taskId`, so a
            // forged payload that pairs an owned `agentId` with another
            // tenant's `taskId` cannot attach a run to that task. The
            // legitimate dispatch path (`TaskTransitionService`) always derives
            // `taskId` from a task the `userId` owns, so this never rejects a
            // real run. We resolve `taskRow` here (instead of after
            // markStarted) and reuse it for prompt assembly below — null only
            // for a foreign/missing task, in which case we skip without
            // mutating any run state. The reason is non-leaking and does not
            // echo the caller-supplied `taskId`.
            const taskRow = await tasks.getOne(payload.userId, payload.taskId).catch(() => null);
            if (!taskRow) {
                return { status: 'skipped', reason: 'task-not-found' };
            }

            // Look up the dispatcher-queued in-flight run (created when
            // TaskTransitionService fanned out the dispatch). If we
            // don't find one, create on the fly so the audit trail is
            // consistent.
            let run = payload.runId ? await runs.findById(payload.runId) : null;
            if (run && (run.agentId !== agent.id || run.taskId !== payload.taskId)) {
                return {
                    status: 'skipped',
                    reason: 'run-payload-mismatch',
                    agentId: payload.agentId,
                };
            }
            if (run && run.status !== 'queued' && run.status !== 'running') {
                return {
                    status: 'skipped',
                    reason: `run-${run.status}`,
                    agentId: agent.id,
                    taskId: payload.taskId,
                    runId: run.id,
                    dedupKey: payload.dedupKey,
                };
            }
            if (!run) {
                run = await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
            }
            if (!run) {
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: agent.userId,
                    triggerKind: 'task',
                    taskId: payload.taskId,
                });
            }

            await runs.markStarted(run.id, null);

            // `taskRow` was resolved above (owner-scoped) before any run
            // mutation; it is guaranteed non-null here.
            const immediateInput = taskRow
                ? [
                      `Task ${taskRow.slug ?? taskRow.id}: ${neutralizeControlTokens(taskRow.title)}`,
                      taskRow.description
                          ? `Description: ${neutralizeControlTokens(taskRow.description)}`
                          : null,
                      `Status: ${taskRow.status}`,
                      `Priority: ${taskRow.priority}`,
                      taskRow.labels?.length ? `Labels: ${taskRow.labels.join(', ')}` : null,
                  ]
                      .filter(Boolean)
                      .join('\n')
                : `Task ${payload.taskId}`;

            const result = await runner.execute({
                runId: run.id,
                agentId: agent.id,
                userId: payload.userId,
                kind: 'task',
                taskId: payload.taskId,
                immediateInput,
                scopeContext: taskRow
                    ? `Task scope: mission=${taskRow.missionId ?? 'none'}, idea=${taskRow.ideaId ?? 'none'}, work=${taskRow.workId ?? 'none'}`
                    : null,
            });

            if (result.status === 'assembled') {
                await runs.markCompleted(run.id, `Prompt assembled for task ${payload.taskId}`);
            } else if (result.status === 'agent-not-found') {
                await runs.markFailed(run.id, 'Agent not found');
            }

            return {
                status:
                    result.status === 'assembled' || result.status === 'dispatched'
                        ? 'completed'
                        : result.status,
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
