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
import {
    AgentsModule,
    SUB_AGENT_DELEGATION_RUNNER,
    SUB_AGENT_DELEGATION_DEPTH_RESOLVER,
    WORKFLOW_NODE_RUNNER,
    // Moved out of apps/api so the `workflow-run` Trigger.dev task can
    // bind it too — a worker cannot import from apps/api. The binding
    // below is unchanged, so the `run_workflow_graph` chat-tool path
    // behaves exactly as before.
    WorkflowNodeRunnerService,
} from '@ever-works/agent/agents';
import { SubAgentDelegationRunnerService } from '../agents/sub-agent-delegation.runner';
import { SubAgentDelegationDepthResolverService } from '../agents/sub-agent-delegation-depth.resolver';
// Memory upgrades M6 — `DecisionConflictService` (the re-litigation
// guard behind `GET /api/tasks/:id/decision-conflicts`) is provided and
// exported by `KnowledgeBaseModule`. NestJS only resolves a controller's
// deps against its own module's imports, so this import is load-bearing:
// without it the API fails to boot with an
// `UnknownDependenciesException: TasksController (..., ?)`.
import { KnowledgeBaseModule } from '@ever-works/agent/services';
// The producer behind the "local runner fallback → cloud" inbox entry.
// `NotificationsModule` is re-exported by FleetApiModule (imported
// below), so the token resolves without a second import here.
import { NotificationService } from '@ever-works/agent/notifications';
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
import { FleetTaskScopeResolverService } from '../fleet/fleet-task-scope.resolver';
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
        // Provided HERE rather than in FleetApiModule because it reads
        // `TaskRepository`, which TasksDomainModule exports and the fleet
        // module does not import — the same split
        // `SubAgentDelegationDepthResolverService` already uses.
        FleetTaskScopeResolverService,
        {
            provide: AGENT_TASK_EXECUTE_DISPATCHER,
            useFactory: (
                fleetRouter: FleetRunRouterService,
                scopeResolver: FleetTaskScopeResolverService,
                notifications: NotificationService,
            ) =>
                createFleetAwareAgentTaskExecuteDispatcher(
                    agentTaskExecuteTriggerAdapter,
                    fleetRouter,
                    { scopeResolver, notifications },
                ),
            inject: [FleetRunRouterService, FleetTaskScopeResolverService, NotificationService],
        },
        { provide: AGENT_CHAT_REPLY_DISPATCHER, useValue: agentChatReplyTriggerAdapter },
        // Judgment layers G5 + G9 — the two runner seams the agents module
        // declares @Optional() and documents as "bound by the api-side
        // @Global() module". Nothing ever bound them, so
        // `WorkflowGraphExecutorService` could validate a graph but never
        // execute a node, and every delegation was refused `no-runner`.
        //
        // They live HERE for the same reason the dispatchers do: the
        // delegation runner needs the job-runtime dispatcher to start a
        // child run, and only this module has it.
        SubAgentDelegationRunnerService,
        { provide: SUB_AGENT_DELEGATION_RUNNER, useExisting: SubAgentDelegationRunnerService },
        WorkflowNodeRunnerService,
        { provide: WORKFLOW_NODE_RUNNER, useExisting: WorkflowNodeRunnerService },
        // Judgment layer G9 — the depth seam. Without it the delegation
        // ceiling is evaluated against a caller-declared integer that
        // nothing raises, so `depth >= maxDepth` never fires. Bound here
        // because the resolver reads the Task/AgentRun rows the delegation
        // runner writes, and DatabaseModule is already imported.
        SubAgentDelegationDepthResolverService,
        {
            provide: SUB_AGENT_DELEGATION_DEPTH_RESOLVER,
            useExisting: SubAgentDelegationDepthResolverService,
        },
    ],
    exports: [
        AGENT_TASK_EXECUTE_DISPATCHER,
        AGENT_CHAT_REPLY_DISPATCHER,
        SUB_AGENT_DELEGATION_RUNNER,
        SUB_AGENT_DELEGATION_DEPTH_RESOLVER,
        WORKFLOW_NODE_RUNNER,
    ],
})
export class TasksModule {}
