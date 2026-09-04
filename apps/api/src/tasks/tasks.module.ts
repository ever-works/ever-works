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
// Agent execution v2 — the ONLY module that provides + exports
// `SkillsService` (and `SkillBindingRepository` behind it).
// `FleetAgentTaskPlannerService` (provided below) injects the SERVICE
// `@Optional()` to assemble the fleet system prompt's `# ACTIVE SKILLS`
// segment — the service is the grant-aware wrapper, so the fleet prompt
// drops the same skills the cloud path drops. The agent-side
// `AgentsModule` imports this module for `AgentRunService` but does NOT
// re-export it, and neither does the @Global() api-side AgentsModule
// (token list only) — so without this import the planner's dependency
// silently resolved to `undefined` and every fleet run shipped a prompt
// with no skills, while the SAME agent honoured them on the cloud path.
// Same reason (and same import) `apps/api/src/agents` and
// `.../organizations` already carry it; SkillsModule is a leaf here, so
// no cycle.
import { SkillsModule as AgentSkillsModule } from '@ever-works/agent/skills';
// Tasks upgrades — the per-Task activity feed endpoint injects
// ActivityLogService, which TasksDomainModule imports but does not
// re-export; the controller resolves it against THIS module's imports.
import { ActivityLogModule as AgentActivityLogModule } from '@ever-works/agent/activity-log';
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
import { FleetAgentTaskPlannerService } from '../fleet/fleet-agent-task-planner.service';
import { FleetAgentTaskReconcilerService } from '../fleet/fleet-agent-task-reconciler.service';
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
    imports: [
        TasksDomainModule,
        DatabaseModule,
        AgentsModule,
        // Supplies SkillsService to FleetAgentTaskPlannerService — see the
        // import comment above; without it the fleet prompt carries no
        // ACTIVE SKILLS.
        AgentSkillsModule,
        KnowledgeBaseModule,
        FleetApiModule,
        AgentActivityLogModule,
    ],
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
        // Agent execution v2 — builds the model-CLI job for a fleet-bound
        // run. Provided HERE (not in FleetApiModule) for the same reason
        // the scope resolver is: it needs the Task / Agent / workspace
        // services this module already has.
        FleetAgentTaskPlannerService,
        // Agent execution v2 (slice B) — listens for `fleet.job.leased` /
        // `fleet.job.completed` and mirrors the node's verdict onto the
        // AgentRun, the Task board, the pull request and the Task chat.
        // Same placement rationale as the planner.
        FleetAgentTaskReconcilerService,
        {
            provide: AGENT_TASK_EXECUTE_DISPATCHER,
            useFactory: (
                fleetRouter: FleetRunRouterService,
                scopeResolver: FleetTaskScopeResolverService,
                notifications: NotificationService,
                planner: FleetAgentTaskPlannerService,
            ) =>
                createFleetAwareAgentTaskExecuteDispatcher(
                    agentTaskExecuteTriggerAdapter,
                    fleetRouter,
                    { scopeResolver, notifications, planner },
                ),
            inject: [
                FleetRunRouterService,
                FleetTaskScopeResolverService,
                NotificationService,
                FleetAgentTaskPlannerService,
            ],
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
