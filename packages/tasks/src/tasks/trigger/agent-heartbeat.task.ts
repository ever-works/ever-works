import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { config } from '@ever-works/agent/config';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { AgentRunService, computeNextHeartbeat } from '@ever-works/agent/agents';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
// Security: import assertUuid to validate Trigger.dev payload fields before any DB access
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

export interface AgentHeartbeatPayload {
    agentId: string;
    userId: string;
    runId?: string;
    /** ISO string — Date doesn't serialize cleanly across Trigger.dev. */
    scheduledFor: string;
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 6.4.
 *
 * One-shot heartbeat run for a single Agent. The dispatcher CAS-claims
 * the Agent first (status: active → running) and only then enqueues
 * this task — so the worker is guaranteed to be the sole runner for
 * this Agent's `nextHeartbeatAt` slot.
 *
 * v1 of the worker is intentionally a placeholder: it marks the
 * persisted `AgentRun` row as started, records a TODO note, computes
 * + writes the next heartbeat slot, and releases the Agent back to
 * `active`. The real prompt-assembly + LLM + skills + tools loop
 * lands in Phase 7 (`AgentRunService.execute`).
 *
 * Failure path: if the worker throws, the `onFailure` hook
 * increments the Agent's `errorCount` (auto-pausing past the
 * threshold) and marks the AgentRun row as `failed`. Releasing the
 * lock is intentional — leaving the Agent stuck in RUNNING would
 * hide it from the dispatcher forever; the stuck-row sweep in the
 * dispatcher is a backstop, not a primary path.
 */
export const agentHeartbeatTask = task<'agent-heartbeat', AgentHeartbeatPayload>({
    id: 'agent-heartbeat',
    maxDuration: config.agents.getMaxRunDurationSeconds(),
    onFailure: async ({ payload, error }) => {
        if (!payload) return;
        // Security: validate payload IDs before any DB access (defense-in-depth, mirrors createTaskContext)
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        try {
            const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
            appContext.useLogger(createTriggerLogger('AgentHeartbeat:Failure'));
            try {
                const agents = appContext.get(AgentRepository);
                const runs = appContext.get(AgentRunRepository);
                const message = error instanceof Error ? error.message : String(error);

                // Recompute next slot from cadence so retry happens at the
                // natural next fire — not "right now".
                const agent = await agents.findById(payload.agentId);
                const next = agent ? computeNextHeartbeat(agent.heartbeatCadence) : null;
                await agents.incrementErrorCount(payload.agentId, next);

                const run = payload.runId
                    ? await runs.findById(payload.runId)
                    : await runs.findInFlightForAgent(payload.agentId);
                if (run && (run.status === 'queued' || run.status === 'running')) {
                    await runs.markFailed(run.id, message);
                }
            } finally {
                await appContext.close();
            }
        } catch {
            // Best-effort — if we can't even boot the context the
            // dispatcher's stuck-running recovery will eventually
            // unstick the row at the next tick window.
        }
    },
    run: async (payload: AgentHeartbeatPayload) => {
        // Security: validate payload IDs before any DB access (defense-in-depth, mirrors createTaskContext)
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentHeartbeat'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);

            const agent = await agents.findById(payload.agentId);
            if (!agent) {
                return { status: 'skipped', reason: 'agent-not-found', agentId: payload.agentId };
            }

            const runner = appContext.get(AgentRunService);
            let run = payload.runId ? await runs.findById(payload.runId) : null;
            if (run && run.agentId !== agent.id) {
                return {
                    status: 'skipped',
                    reason: 'run-agent-mismatch',
                    agentId: payload.agentId,
                };
            }
            if (run && run.status === 'cancelled') {
                const nextSlot = computeNextHeartbeat(agent.heartbeatCadence);
                await agents.releaseAfterRun(agent.id, nextSlot, 'cancelled');
                return {
                    status: 'skipped',
                    reason: 'run-cancelled',
                    agentId: agent.id,
                    runId: run.id,
                    nextHeartbeatAt: nextSlot?.toISOString() ?? null,
                };
            }
            if (run && run.status !== 'queued' && run.status !== 'running') {
                const nextSlot = computeNextHeartbeat(agent.heartbeatCadence);
                await agents.releaseAfterRun(agent.id, nextSlot, run.status);
                return {
                    status: 'skipped',
                    reason: `run-${run.status}`,
                    agentId: agent.id,
                    runId: run.id,
                    nextHeartbeatAt: nextSlot?.toISOString() ?? null,
                };
            }
            if (!run) {
                run = await runs.findInFlightForAgent(agent.id);
            }
            if (!run) {
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: payload.userId,
                    triggerKind: 'heartbeat',
                });
            }

            await runs.markStarted(run.id, null);
            const result = await runner.execute({
                runId: run.id,
                agentId: agent.id,
                userId: payload.userId,
                kind: 'heartbeat',
            });

            if (result.status === 'assembled') {
                await runs.markCompleted(
                    run.id,
                    `Prompt assembled for heartbeat scheduled ${payload.scheduledFor}`,
                );
            }

            const nextSlot = computeNextHeartbeat(agent.heartbeatCadence);
            const completed = result.status === 'assembled' || result.status === 'dispatched';
            if (completed) {
                await agents.releaseAfterRun(agent.id, nextSlot, 'completed');
            } else {
                await agents.incrementErrorCount(agent.id, nextSlot);
            }

            return {
                status: completed ? 'completed' : result.status,
                agentId: agent.id,
                runId: run.id,
                nextHeartbeatAt: nextSlot?.toISOString() ?? null,
            };
        } finally {
            await appContext.close();
        }
    },
});
