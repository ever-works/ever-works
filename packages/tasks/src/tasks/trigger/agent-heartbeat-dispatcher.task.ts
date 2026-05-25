import { schedules, tasks } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { config } from '@ever-works/agent/config';
import {
    AgentScheduleDispatcherService,
    type AgentHeartbeatTrigger,
} from '@ever-works/agent/agents';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
import type { AgentHeartbeatPayload } from './agent-heartbeat.task';

const interval = Math.max(1, config.agents.getDispatchIntervalMinutes());
const cronExpression = `*/${interval} * * * *`;

/**
 * Agents/Skills/Tasks PR #1017 — Phase 6.1.
 *
 * Cron-driven Agent heartbeat dispatcher. Mirrors the
 * `work-schedule-dispatcher` task: one Trigger.dev `schedules.task`
 * fires every `AGENT_DISPATCH_INTERVAL_MINUTES` minutes (default 1),
 * boots a transient Nest application context for the
 * `TriggerInternalModule`, and asks
 * `AgentScheduleDispatcherService.dispatchDue` for due rows.
 *
 * The dispatcher delegates enqueueing the per-Agent run to the
 * `AgentHeartbeatTrigger` adapter passed in here — that's where
 * `tasks.trigger('agent-heartbeat', payload)` actually fires. Keeping
 * the trigger out of the service means the service has no runtime
 * dependency on `@trigger.dev/sdk` and stays cheap to unit test.
 */
export const agentHeartbeatDispatcherTask = schedules.task({
    id: 'agent-heartbeat-dispatcher',
    cron: cronExpression,
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentHeartbeatDispatcher'));

        try {
            const dispatcher = appContext.get(AgentScheduleDispatcherService);

            const trigger: AgentHeartbeatTrigger = {
                async enqueue(payload) {
                    const handle = await tasks.trigger<typeof import('./agent-heartbeat.task').agentHeartbeatTask>(
                        'agent-heartbeat',
                        {
                            agentId: payload.agentId,
                            userId: payload.userId,
                            scheduledFor: payload.scheduledFor.toISOString(),
                        } satisfies AgentHeartbeatPayload,
                    );
                    return { runId: handle.id };
                },
            };

            const summary = await dispatcher.dispatchDue(trigger);
            return { intervalMinutes: interval, ...summary };
        } finally {
            await appContext.close();
        }
    },
});
