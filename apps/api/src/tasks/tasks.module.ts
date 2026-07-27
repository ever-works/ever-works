import { Global, Module } from '@nestjs/common';
import {
    TasksDomainModule,
    AGENT_TASK_EXECUTE_DISPATCHER,
    AGENT_CHAT_REPLY_DISPATCHER,
} from '@ever-works/agent/tasks-domain';
import { DatabaseModule } from '@ever-works/agent/database';
// Review-fix I5 (second-pass NEW-2): AgentsModule re-exports
// AgentRepository so the TasksController + TaskChatController can
// inject it for mention-lookup population. Without this import the
// controllers would fail to instantiate at boot with an "argument
// AgentRepository is not available" Nest error.
import { AgentsModule } from '@ever-works/agent/agents';
// Memory upgrades M6 — `DecisionConflictService` (the re-litigation
// guard behind `GET /api/tasks/:id/decision-conflicts`) is provided and
// exported by `KnowledgeBaseModule`. NestJS only resolves a controller's
// deps against its own module's imports, so this import is load-bearing:
// without it the API fails to boot with an
// `UnknownDependenciesException: TasksController (..., ?)`.
import { KnowledgeBaseModule } from '@ever-works/agent/services';
import {
    agentTaskExecuteTriggerAdapter,
    agentChatReplyTriggerAdapter,
} from '@ever-works/trigger-tasks';
// AUDIT A46/A24 — the fleet producer. `FleetApiModule` constructs the
// `job-runtime-node` dispatcher factory over the real `fleet_jobs`
// store; `FleetRunRouterService` decides per run whether the resolved
// runtime is the owner's Fleet and, when it is, writes the lease-able
// row an enrolled node polls for.
import { FleetApiModule } from '../fleet/fleet.module';
import { FleetRunRouterService } from '../fleet/fleet-run-router.service';
import { createFleetAwareAgentTaskExecuteDispatcher } from '../fleet/fleet-agent-task.dispatcher';
import { TasksController } from './tasks.controller';
import { TaskChatController } from './task-chat.controller';

/**
 * Tasks feature — Phases 12 + 13 + 15. API-side module.
 *
 *   - TasksDomainModule   — TasksService + TaskTransitionService +
 *                           TaskChatService + repositories
 *   - DatabaseModule      — PluginUsageRepository for the Phase-15
 *                           per-Task spend rollup endpoint
 *   - dispatcher tokens   — bind the production Trigger.dev adapters
 *                           so * → in_progress and @agent chat
 *                           mentions fan out to agent-task-execute /
 *                           agent-chat-reply runs.
 */
// PASS-4 review fix (CRITICAL): @Global() is required so the
// dispatcher tokens (provided HERE in api-side TasksModule) actually
// reach the consumers (TaskTransitionService + TaskChatService in
// the imported TasksDomainModule). NestJS doesn't propagate providers
// from a child module up into the imported module's DI scope —
// without @Global() the @Optional() @Inject(AGENT_*_DISPATCHER) in
// the agent-package services would silently resolve to undefined,
// breaking the entire Phase 15.3 / 15.4 dispatch fan-out.
@Global()
@Module({
    imports: [TasksDomainModule, DatabaseModule, AgentsModule, KnowledgeBaseModule, FleetApiModule],
    controllers: [TasksController, TaskChatController],
    providers: [
        // AUDIT A46/A24 — routing binding, not a replacement: the
        // Trigger.dev adapter is still the dispatcher for every install
        // that has not selected the fleet runtime. Only a run whose
        // resolved runtime is `node` diverts onto the owner's Fleet,
        // where it becomes a lease-able `agent-task` job.
        {
            provide: AGENT_TASK_EXECUTE_DISPATCHER,
            useFactory: (fleetRouter: FleetRunRouterService) =>
                createFleetAwareAgentTaskExecuteDispatcher(
                    agentTaskExecuteTriggerAdapter,
                    fleetRouter,
                ),
            inject: [FleetRunRouterService],
        },
        { provide: AGENT_CHAT_REPLY_DISPATCHER, useValue: agentChatReplyTriggerAdapter },
    ],
    exports: [AGENT_TASK_EXECUTE_DISPATCHER, AGENT_CHAT_REPLY_DISPATCHER],
})
export class TasksModule {}
