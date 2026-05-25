import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { config } from '@ever-works/agent/config';
import {
    AgentRepository,
    AgentRunRepository,
} from '@ever-works/agent/database';
import { computeNextHeartbeat } from '@ever-works/agent/agents';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export interface AgentHeartbeatPayload {
    agentId: string;
    userId: string;
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

                const inFlight = await runs.findInFlightForAgent(payload.agentId);
                if (inFlight) {
                    await runs.markFailed(inFlight.id, message);
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
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentHeartbeat'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);

            const agent = await agents.findById(payload.agentId);
            if (!agent) {
                return { status: 'skipped', reason: 'agent-not-found', agentId: payload.agentId };
            }

            // Phase 6 placeholder — Phase 7's AgentRunService.execute()
            // wires PromptAssembler + AiFacade + tools + skills. v1 just
            // logs that the heartbeat fired so the loop is observable
            // end-to-end before the orchestrator lands.
            const summary = `Phase 6 placeholder heartbeat — scheduled ${payload.scheduledFor}`;

            const inFlight = await runs.findInFlightForAgent(agent.id);
            if (inFlight) {
                await runs.markStarted(inFlight.id, null);
                await runs.markCompleted(inFlight.id, summary);
            }

            const nextSlot = computeNextHeartbeat(agent.heartbeatCadence);
            await agents.releaseAfterRun(agent.id, nextSlot, 'completed');

            return {
                status: 'completed',
                agentId: agent.id,
                nextHeartbeatAt: nextSlot?.toISOString() ?? null,
            };
        } finally {
            await appContext.close();
        }
    },
});
