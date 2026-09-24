import { Global, Module } from '@nestjs/common';
import {
    AgentsModule as AgentAgentsModule,
    AgentRepository,
    AGENT_HEARTBEAT_TRIGGER,
    AGENT_RUN_CANCELLER,
    AGENT_RUN_CHAT_BACK_POSTER,
    AGENT_RUN_CONVERSATION_REPLY_POSTER,
    AGENT_RUN_TASK_FINISHER,
    AGENT_PLUGIN_TOOLS_FACADE,
    AGENT_AI_DISPATCH_FACADE,
    AGENT_GIT_FACADE,
    AGENT_EMAIL_FACADE,
    AGENT_NOTIFY_CHANNEL_FACADE,
    AGENT_DOMAIN_TOOL_SOURCES,
    AGENT_MCP_TOOL_SOURCE,
    SKILL_FILE_CONTENT_READER,
    ROSTER_SKILL_BINDER,
    RUN_KILL_SWITCH,
    AgentEscalationService,
    RunSteeringService,
    WorkflowGraphExecutorService,
    type AgentDomainToolSources,
    TERMINAL_SESSION_DISPATCHER,
    TerminalSessionLauncher,
    type AgentRunChatBackPoster,
    type AgentRunConversationReplyPoster,
    type AgentRunTaskFinisher,
    type AgentPluginToolsFacade,
    type AgentAiDispatchFacade,
    type AgentAiToolCall,
    type AgentGitFacade,
    type AgentEmailFacade,
    type AgentNotifyChannelFacade,
} from '@ever-works/agent/agents';
import {
    AgentEmailAssignmentRepository,
    TenantEmailAddressRepository,
    NotificationChannelRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { NotificationChannelFacadeService } from '@ever-works/agent/facades';
import { EmailModule } from '../email/email.module';
import { EmailService } from '../email/email.service';
import {
    INBOUND_EMAIL_TASK_SPAWNER,
    type InboundEmailTaskSpawner,
} from '@ever-works/agent/notifications';
import {
    agentHeartbeatTriggerAdapter,
    createAgentRunCancellerAdapter,
    terminalSessionTriggerAdapter,
    TriggerModule as TasksTriggerModule,
    TriggerService,
} from '@ever-works/trigger-tasks';
// APW-08 P0 — `getWorkCapabilities` decides WHICH of a Work's repository
// records the Agent git tools act on (a `repo` Work wraps an existing code
// repository and provisions no website repo at all), and `RepositoryRole`
// names the roles it chooses between. Same two imports, and the same rule,
// as `repos[role]` in `packages/agent/src/works/repository-work-guard.ts`
// (`hasRepositoryRole`) — the ONE place that knowledge lives.
import { getWorkCapabilities } from '@ever-works/contracts';
import type { RepositoryRole } from '@ever-works/contracts/api';

// Phase 16.6 / 16.7 — commitToRepo / openPullRequest tools.
// The `AGENT_GIT_FACADE` token (exported from `@ever-works/agent/agents`)
// is deliberately LEFT UNBOUND in v1. Binding it activates the two
// tools for Agents with the matching permissions; the adapter
// implementation resolves the Work's git provider settings + auth via
// `GitFacadeService.commit()` / `.createPullRequest()`. Operators wire
// it post-merge when their git provider setup is stable. Leaving it
// unbound keeps the model from seeing tools that would fail mysteriously.
import {
    TasksDomainModule,
    TaskChatService,
    TasksService,
    TaskStatus,
    TaskAssigneeRepository,
    TaskReviewerRepository,
    TaskApproverRepository,
    TaskAgentReviewService,
    RUN_STEERING_PORT,
    TERMINAL_SESSION_STARTER,
} from '@ever-works/agent/tasks-domain';
// Domain chat-tool sources (AGENT_DOMAIN_TOOL_SOURCES binding below).
// Each module contributes the ONE service/repository its descriptor
// factory needs; the descriptors themselves are assembled inside
// `AgentToolService.resolveAllowedTools` — the tool loop's single
// assembly point.
import { EventIngestModule, IngestedEventRepository } from '@ever-works/agent/ingest';
import { DigestModule, DigestService } from '@ever-works/agent/digest';
import { MeetingsModule, MeetingRepository } from '@ever-works/agent/meetings';
import {
    FleetJobService,
    FleetKillSwitchService,
    FleetModule,
    FleetService,
} from '@ever-works/agent/fleet';
import { createFleetAwareAgentRunCanceller } from '../fleet/fleet-agent-run-canceller';
import { PrReviewModule, PrReviewService } from '@ever-works/agent/pr-review';
import {
    PolicyModule,
    MergePolicyService,
    PullRequestGateService,
    ToolGrantService,
} from '@ever-works/agent/policy';
import { SAFETY_GATE, SafetyGateService, SafetyModule } from '@ever-works/agent/safety';
import { WorkOwnershipService } from '@ever-works/agent/services';
import {
    FacadesModule,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    AiFacadeService,
    GitFacadeService,
    BrowserAutomationFacadeService,
} from '@ever-works/agent/facades';
// FU-2 — `AgentsController` injects `SkillBindingRepository` (for the
// `GET /api/agents/:id/skills` rollup) and `PluginUsageRepository` (for
// the `GET /api/agents/:id/budget` rollup). Their providers live in
// the agent-side `SkillsModule` / `DatabaseModule` — neither is
// re-exported by `AgentAgentsModule`, so we must import them directly
// here for Nest to resolve the controller's constructor args. Same
// posture as api-side `TasksModule` importing `DatabaseModule` for
// `PluginUsageRepository`.
import { SkillsModule as AgentSkillsModule } from '@ever-works/agent/skills';
import { DatabaseModule } from '@ever-works/agent/database';
// Agent Plugins MCP slice — McpToolSource backs the AGENT_MCP_TOOL_SOURCE
// binding below so agent runs expose `mcp__<server>__<tool>` descriptors.
import { McpModule, McpToolSource } from '@ever-works/agent/mcp';
// Inbox (operator message center) — InboxService backs the `ask_human`
// domain tool source below. The agent-side InboxModule imports the
// agent-side AgentsModule / AgentApprovalsModule / NotificationsModule
// (never anything api-side), so no cycle is introduced.
import { InboxModule as AgentInboxModule, InboxService } from '@ever-works/agent/inbox';
// Named Conversations — ConversationMessageService backs the
// AGENT_RUN_CONVERSATION_REPLY_POSTER binding below. The agent-side
// ConversationsModule imports only DatabaseModule and the agent-side
// AgentsModule (never anything api-side), so no cycle is introduced.
import { ConversationsModule, ConversationMessageService } from '@ever-works/agent/conversations';
// AW-23 — AgentApprovalsService backs the identity card's "Waiting on
// you" reason (pending proposals alongside open escalations). The
// agent-side AgentApprovalsModule registers its own two entities and
// imports nothing else, so no cycle is introduced.
import { AgentApprovalsModule } from '@ever-works/agent/agent-approvals';
// ActivityLogService is injected @Optional() into AgentsController for
// the lifecycle trail (AGENT_PAUSED / AGENT_RESUMED / run-triggered /
// run-cancelled / task-assigned) and the GET :id/events feed. Without
// this import the optional injection silently resolved to `undefined`
// and every tryLog() was a no-op — same wiring as works/plugins/auth.
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { AuthModule } from '../auth/auth.module';
// Skill files feature — the uploads-spine content reader behind the
// agent-side `getSkillFile` tool. The class lives in (and is exported
// by) the api-side SkillsModule; the token binding lives HERE because
// this module is @Global(), so the agent-side AgentToolService's
// @Optional() @Inject(SKILL_FILE_CONTENT_READER) resolves in production.
import { SkillsModule as ApiSkillsModule } from '../skills/skills.module';
// AW-20 P1 — backs the ROSTER_SKILL_BINDER binding below so a provisioned
// roster agent arrives with its lane's suggested Skills already attached.
import { RosterSkillBinderAdapter } from './roster-skill-binder.adapter';
// APW-08 P0 (T2, plan §2.2) — ONE commit per Work at a time. The two Agent git
// tools work in the same working copy of a Work's repository, so two commits
// for one Work would interleave: the second `switchBranch` can move the
// checkout under the first `push`, and the first commit then lands on the
// wrong branch, or nowhere at all.
import { withWorkCommitLock } from './work-commit-lock';
import { SkillFileContentReaderService } from '../skills/skill-file-content-reader.service';
import { AgentsController } from './agents.controller';
import { AgentIdentityService } from './agent-identity.service';
import { AgentCollaboratorsController } from './agent-collaborators.controller';
import { AgentTemplatesController } from './agent-templates.controller';
import { AgentTemplateCatalogService } from './agent-template-catalog.service';

/**
 * AW-05 — what an Agent is told when its message is held for a person.
 * Worded so the model does not retry or resend the same message, and does
 * not promise delivery: an approved draft is still subject to the send
 * limits, which can refuse it.
 */
const HELD_FOR_APPROVAL_NOTE =
    "Not sent yet: this agent's inbox holds email for review. The message is saved as a draft and can be sent after a person approves it, subject to send limits. Do not send it again.";

/**
 * Agents/Skills/Tasks PR #1017 — api-side AgentsModule (Phase 3 + 15.5 + 16.10).
 *
 * Mounts the AgentsController; defers to the agent-side AgentsModule
 * for the service + repositories + entities.
 *
 * Phase 15.5: binds the `chat-back poster` + `task finisher`
 * post-processor tokens to platform services so
 * `AgentRunService.finalize()` can route auto-replies through
 * `TaskChatService.post(authorType='agent')` and status flips
 * through `TasksService.transition()`. Same posture as
 * `TasksModule` binding the `agent-task-execute` /
 * `agent-chat-reply` dispatcher tokens (Phase 15.3 / 15.4) —
 * keeps the agent package free of a hard `@ever-works/agent/tasks-domain`
 * runtime dependency at the AgentsModule layer.
 *
 * Phase 16.10: binds `AGENT_PLUGIN_TOOLS_FACADE` to a thin adapter
 * that forwards `searchWeb` / `screenshot` / `extractContent` calls
 * to `SearchFacadeService.search`, `ScreenshotFacadeService.capture`,
 * `ContentExtractorFacadeService.extractContent`. Each forwarded call
 * threads `agentId` + optional `taskId` onto `FacadeOptions` so the
 * Phase 15.6 attribution lands on every resulting `PluginUsageEvent`.
 */
/**
 * APW-08 P0 — the protected RELEASE branches an Agent may never commit to.
 *
 * This list is the FLOOR and is deliberately NOT configurable: `main`,
 * `master` and `stage` are the branches a release is cut from, and an
 * Agent pushing straight to one is the defect this exists to make
 * impossible. The Work's effective merge policy `protectedBranches`
 * (`PLATFORM_DEFAULT_MERGE_POLICY` and its tenant/organization/Work/Agent
 * overrides, resolved by `MergePolicyService`) is unioned ON TOP of it, so
 * an operator can protect MORE branches at any scope — never fewer.
 */
const PROTECTED_RELEASE_BRANCHES: readonly string[] = ['main', 'master', 'stage'];

/**
 * APW-08 P0 (T3, APW08-G24) — the working copy a Work's Agent git operations
 * use, named by the convention `work:<workId>:<role>` (APW-02 P0,
 * `GitCloneOptions.checkoutKey`).
 *
 * `cloneOrPull` keys its in-flight operations by plugin/owner/repo/branch/switch
 * and the DIRECTORY by owner+repo alone (`packages/agent/src/facades/git.facade.ts`),
 * so without a key another caller of the same data repository — a generator that
 * switches to `main`, the provisioner — can move the checkout under a commit.
 * {@link withWorkCommitLock} serializes only this adapter's own calls on one
 * Work; the checkout key is what separates this Work's operations from every
 * other caller's.
 */
function workCheckoutKey(workId: string): string {
    return `work:${workId}:agent-commit`;
}

/**
 * `refs/heads/x` and `X` name the same branch as `x`.
 *
 * Deliberately the same normalization the merge path uses
 * (`@ever-works/agent` `policy/merge-policy.ts`), so "protected" means one
 * thing across the platform rather than two.
 */
function normalizeBranchRef(ref: string): string {
    return ref
        .trim()
        .replace(/^refs\/heads\//i, '')
        .toLowerCase();
}

// PASS-4 review fix (CRITICAL): @Global() is required for the same
// reason as TasksModule — the post-processor + plugin-tools-facade
// token bindings live HERE in api-side AgentsModule, but the
// consumers (AgentRunService.finalize, AgentToolService) live in
// the imported `AgentAgentsModule`. Without @Global() those
// @Optional() @Inject() calls would silently resolve to undefined
// in production, breaking Phase 15.5 + Phase 16.10 surfaces despite
// every unit test passing.
@Global()
@Module({
    imports: [
        AgentAgentsModule,
        AgentSkillsModule,
        DatabaseModule,
        TasksDomainModule,
        FacadesModule,
        AuthModule,
        ActivityLogModule,
        // Notifications v2 (EW-670) — EmailModule provides EmailService,
        // consumed by the AGENT_EMAIL_FACADE binding below.
        EmailModule,
        // Provides TriggerService, which backs the AGENT_RUN_CANCELLER factory
        // below. Same alias works.module.ts / webhooks.module.ts already use.
        TasksTriggerModule,
        // Domain chat tools — the services the AGENT_DOMAIN_TOOL_SOURCES
        // binding hands to `AgentToolService`. None of these modules
        // imports anything api-side, so no cycle is introduced.
        EventIngestModule,
        DigestModule,
        MeetingsModule,
        FleetModule,
        PrReviewModule,
        PolicyModule,
        // Safety rails (AW-24) — supplies `SafetyGateService`, which THIS
        // module re-binds to the `SAFETY_GATE` token below and exports, so
        // the @Optional() @Inject in the agent-side `AgentRunService`
        // actually resolves. SafetyModule imports only its own tables, so
        // no cycle.
        SafetyModule,
        // Agent Plugins MCP slice — provides McpToolSource for the
        // AGENT_MCP_TOOL_SOURCE binding below. Imports nothing api-side,
        // so no cycle is introduced.
        McpModule,
        AgentInboxModule,
        // Skill files — supplies SkillFileContentReaderService for the
        // SKILL_FILE_CONTENT_READER binding below. api SkillsModule
        // imports nothing api-side beyond UploadsModule/AuthModule, so
        // no cycle is introduced.
        ApiSkillsModule,
        // Named Conversations — supplies ConversationMessageService for the
        // AGENT_RUN_CONVERSATION_REPLY_POSTER binding below.
        ConversationsModule,
        // AW-23 — the identity card's "Waiting on you" reason counts
        // PENDING approval proposals alongside open escalations.
        // AgentApprovalsModule is a leaf (its own entities and nothing
        // api-side), so no cycle is introduced.
        AgentApprovalsModule,
    ],
    controllers: [AgentsController, AgentCollaboratorsController, AgentTemplatesController],
    providers: [
        AgentTemplateCatalogService,
        // AW-23 — composes the one payload the identity card paints from.
        AgentIdentityService,
        // Security: provided LOCALLY (not exported) so the merge-policy
        // chat tool's owner check runs the same `ensureAccess` gate the
        // HTTP surface does. Its deps (WorkRepository / WorkMemberRepository)
        // come from the DatabaseModule import above.
        WorkOwnershipService,
        { provide: AGENT_HEARTBEAT_TRIGGER, useValue: agentHeartbeatTriggerAdapter },
        {
            provide: AGENT_RUN_CANCELLER,
            // Agent execution v2 (slice B) — a run's remote id is a fleet
            // job id when the fleet executed it; the composite adapter
            // tries the fleet for uuid-shaped ids and falls through to
            // Trigger.dev otherwise. `FleetModule` (imported above) exports
            // FleetJobService.
            inject: [TriggerService, FleetJobService],
            useFactory: (trigger: TriggerService, fleetJobs: FleetJobService) =>
                createFleetAwareAgentRunCanceller(
                    createAgentRunCancellerAdapter(trigger),
                    fleetJobs,
                ),
        },
        {
            provide: AGENT_RUN_CHAT_BACK_POSTER,
            inject: [TaskChatService],
            useFactory: (chat: TaskChatService): AgentRunChatBackPoster => ({
                async postReply({ userId, taskId, agentId, body }) {
                    const row = await chat.post(userId, {
                        taskId,
                        authorType: 'agent',
                        authorId: agentId,
                        body,
                    });
                    return { messageId: row.id };
                },
            }),
        },
        // Named Conversations — `AgentRunService.finalize()` stores a
        // Conversation reply through this port BEFORE it marks the run
        // completed, so a completed run can never have lost its reply. Keyed
        // by run id, so finalizing the same run again stores nothing new.
        {
            provide: AGENT_RUN_CONVERSATION_REPLY_POSTER,
            inject: [ConversationMessageService],
            useFactory: (
                messages: ConversationMessageService,
            ): AgentRunConversationReplyPoster => ({
                async postReply({ runId, userId, agentId, conversationMessageId, body }) {
                    const row = await messages.recordAgentReply({
                        runId,
                        userId,
                        agentId,
                        replyToMessageId: conversationMessageId,
                        body,
                    });
                    return { messageId: row.id };
                },
            }),
        },
        {
            provide: AGENT_RUN_TASK_FINISHER,
            inject: [TasksService],
            useFactory: (tasks: TasksService): AgentRunTaskFinisher => ({
                async finishTask({ userId, taskId, to, force }) {
                    const row = await tasks.transition(userId, taskId, to as TaskStatus, {
                        force: force ?? false,
                        // Quality gates (Wave 3 M8): the run finalizer flips
                        // status on the Agent's behalf, so its → in_review is
                        // refused while the latest run's gate is red/skipped
                        // under a 'required' checks policy. Human transitions
                        // (API/UI) never pass actorType and are unaffected.
                        actorType: 'agent',
                    });
                    return { status: row.status };
                },
            }),
        },
        // Run steering (Wave 4 M5) — bind the port `TaskChatService` reaches
        // for when a chat message mentions an agent that already has a LIVE
        // run on the Task. Same @Global() token posture as the post-processor
        // bindings above: the implementation lives in the agent-side
        // AgentsModule (imported here), the consumer lives in
        // TasksDomainModule, and neither package gains a runtime import of
        // the other.
        { provide: RUN_STEERING_PORT, useExisting: RunSteeringService },
        // Panic controls (EW-778) — bind the GLOBAL STOP FLAG port the
        // dispatch gate consults. Same @Global() reasoning as
        // RUN_CREDITS_PRECHECK in SubscriptionsModule: the gate lives in
        // the agent-side AgentsModule and reads this token through an
        // @Optional() @Inject(), which would silently resolve to undefined
        // — and leave the stop flag dark for every new run — if this
        // binding were not global AND exported. `FleetModule` (imported
        // above) exports FleetKillSwitchService.
        { provide: RUN_KILL_SWITCH, useExisting: FleetKillSwitchService },
        // Safety rails (AW-24) — bind the ONE gate every side-effectful
        // action passes through. Exactly the RUN_KILL_SWITCH posture above,
        // and for exactly the same reason: `AgentRunService.invokeTool` is
        // the one place every tool call converges, it reads this token
        // through an @Optional() @Inject(), and that injection resolves to
        // `undefined` — leaving every rail dark while the product still
        // claims them — unless this binding is BOTH global AND exported.
        // `SafetyModule` (imported above) exports SafetyGateService.
        { provide: SAFETY_GATE, useExisting: SafetyGateService },
        // Streaming terminal — the two halves of the session dispatch.
        //
        // TERMINAL_SESSION_DISPATCHER is the job-runtime producer for the
        // `terminal-session` task (which shipped with NO producer at all,
        // so no session was ever started). TERMINAL_SESSION_STARTER is the
        // port `TaskTransitionService` reaches for after a successful
        // fan-out; it points at the same launcher so the ownership check,
        // the CAS duplicate refusal and the persistent gate are stated
        // exactly once. Same @Global() token posture as RUN_STEERING_PORT:
        // implementation in the imported agent-side AgentsModule, consumer
        // in TasksDomainModule, neither package importing the other.
        { provide: TERMINAL_SESSION_DISPATCHER, useValue: terminalSessionTriggerAdapter },
        { provide: TERMINAL_SESSION_STARTER, useExisting: TerminalSessionLauncher },
        // Notifications v2 (EW-670) — INBOUND_EMAIL_TASK_SPAWNER binding.
        // The inbound-email dispatcher's `task-spawn` mode delegates here:
        // create a Task from the inbound email (scoped to the address
        // owner, created-by the receiving agent) and assign that agent so
        // the task-tracking flow dispatches `agent-task-execute`. When this
        // token is unbound the dispatcher persists the message but spawns
        // no Task (graceful no-op).
        {
            provide: INBOUND_EMAIL_TASK_SPAWNER,
            inject: [TasksService],
            useFactory: (tasks: TasksService): InboundEmailTaskSpawner => ({
                async spawnTaskForInboundEmail({ agentId, userId, subject, bodyText, from }) {
                    const title = subject?.trim()
                        ? subject.trim().slice(0, 200)
                        : `Inbound email from ${from}`;
                    const task = await tasks.create(userId, {
                        title,
                        description: bodyText?.trim() ? bodyText.trim().slice(0, 8000) : null,
                        labels: ['inbound-email'],
                        createdByType: 'agent',
                        createdById: agentId,
                    });
                    // Assign the receiving agent so the task-tracking flow
                    // fans out agent-task-execute for it.
                    await tasks.addAssignee(userId, task.id, 'agent', agentId);
                    return { taskId: task.id };
                },
            }),
        },
        {
            provide: AGENT_PLUGIN_TOOLS_FACADE,
            inject: [SearchFacadeService, ScreenshotFacadeService, ContentExtractorFacadeService],
            useFactory: (
                search: SearchFacadeService,
                screenshot: ScreenshotFacadeService,
                extractor: ContentExtractorFacadeService,
            ): AgentPluginToolsFacade => ({
                async searchWeb({
                    userId,
                    workId,
                    agentId,
                    taskId,
                    runId,
                    missionId,
                    query,
                    maxResults,
                    includeDomains,
                    excludeDomains,
                }) {
                    const results = await search.search(
                        query,
                        { maxResults, includeDomains, excludeDomains },
                        // Wave 9 M2 — runId feeds per-run cost attribution;
                        // AW-17 — missionId rolls the usage up to the Task's Mission.
                        { userId, workId, agentId, taskId, runId, missionId },
                    );
                    return {
                        results: results.map((r) => ({
                            title: r.title,
                            url: r.url,
                            snippet: (r as any).snippet ?? null,
                            publishedDate: (r as any).publishedDate ?? null,
                            score: (r as any).score,
                        })),
                    };
                },
                async screenshot({
                    userId,
                    workId,
                    agentId,
                    taskId,
                    runId,
                    missionId,
                    url,
                    viewportWidth,
                    viewportHeight,
                    fullPage,
                }) {
                    const result = await screenshot.capture(
                        { url, viewportWidth, viewportHeight, fullPage } as any,
                        // Wave 9 M2 — runId feeds per-run cost attribution;
                        // AW-17 — missionId rolls the usage up to the Task's Mission.
                        { userId, workId, agentId, taskId, runId, missionId },
                    );
                    return {
                        success: result.success,
                        imageUrl: result.imageUrl ?? null,
                        cacheUrl: result.cacheUrl ?? null,
                    };
                },
                async extractContent({
                    userId,
                    workId,
                    agentId,
                    taskId,
                    runId,
                    missionId,
                    url,
                    maxChars,
                }) {
                    const result = await extractor.extractContent(url, undefined, {
                        userId,
                        workId,
                        agentId,
                        taskId,
                        // Wave 9 M2 — runId feeds per-run cost attribution.
                        runId,
                        // AW-17 — the Task's Mission.
                        missionId,
                    });
                    const raw = result?.rawContent ?? '';
                    const cap = maxChars && maxChars > 0 ? Math.min(maxChars, 200_000) : 50_000;
                    const content = raw.length > cap ? raw.slice(0, cap) : raw;
                    return {
                        url,
                        content,
                        contentLength: raw.length,
                        providerId: result?.extraction?.providerId ?? null,
                    };
                },
            }),
        },
        // FU-1 — AI dispatch facade. Thin adapter over
        // `AiFacadeService.createChatCompletion()` that owns the
        // ToolDefinition mapping + tool-call parsing. The agent-side
        // `AgentRunService.runToolLoop` keeps the actual loop +
        // iteration cap + run-log emission, so this binding stays
        // small (one call per round-trip).
        {
            provide: AGENT_AI_DISPATCH_FACADE,
            inject: [AiFacadeService],
            useFactory: (ai: AiFacadeService): AgentAiDispatchFacade => ({
                async dispatch(input) {
                    const tools = input.tools?.map((t) => ({
                        type: 'function' as const,
                        function: {
                            name: t.name,
                            description: t.description,
                            parameters: t.parameters,
                        },
                    }));
                    const messages = input.messages.map((m) => {
                        const base: Record<string, unknown> = {
                            role: m.role,
                            content: m.content,
                        };
                        if (m.name) base.name = m.name;
                        if (m.toolCallId) base.toolCallId = m.toolCallId;
                        if (m.toolCalls && m.toolCalls.length > 0) {
                            base.toolCalls = m.toolCalls.map((c) => ({
                                id: c.id,
                                type: 'function',
                                function: {
                                    name: c.name,
                                    arguments:
                                        typeof c.args === 'string'
                                            ? c.args
                                            : JSON.stringify(c.args ?? {}),
                                },
                            }));
                        }
                        return base as any;
                    });
                    const response = await ai.createChatCompletion(
                        {
                            model: input.model,
                            messages,
                            tools,
                            temperature: input.temperature ?? 0.4,
                            maxTokens: input.maxTokens,
                            // Aborts the in-flight provider request on cancel.
                            signal: input.abortSignal,
                        },
                        {
                            userId: input.facadeOptions.userId,
                            workId: input.facadeOptions.workId,
                            agentId: input.facadeOptions.agentId,
                            taskId: input.facadeOptions.taskId,
                            // Wave 9 M2 — per-run cost attribution.
                            runId: input.facadeOptions.runId,
                            // AW-17 — the Mission of the run's Task.
                            missionId: input.facadeOptions.missionId,
                            providerOverride: input.facadeOptions.providerOverride,
                        },
                    );
                    const first = response.choices[0];
                    const msg = first?.message;
                    const rawToolCalls = msg?.toolCalls ?? [];
                    const toolCalls: AgentAiToolCall[] = rawToolCalls.map((tc) => {
                        let args: unknown = {};
                        try {
                            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                        } catch {
                            args = tc.function.arguments;
                        }
                        return { id: tc.id, name: tc.function.name, args };
                    });
                    const content = msg?.content ?? '';
                    const text =
                        typeof content === 'string'
                            ? content
                            : Array.isArray(content)
                              ? content
                                    .map((part) =>
                                        typeof part === 'string'
                                            ? part
                                            : part && typeof part === 'object' && 'text' in part
                                              ? (part as { text: string }).text
                                              : '',
                                    )
                                    .join('')
                              : null;
                    return {
                        text: text && text.length > 0 ? text : null,
                        toolCalls,
                        finishReason: first?.finishReason ?? null,
                        usage: response.usage
                            ? {
                                  promptTokens: response.usage.promptTokens,
                                  completionTokens: response.usage.completionTokens,
                                  totalTokens: response.usage.totalTokens,
                              }
                            : undefined,
                        model: response.model,
                    };
                },
            }),
        },
        /**
         * FU-13 — AGENT_GIT_FACADE binding. Routes `commitToRepo` +
         * `openPullRequest` Agent tools through `GitFacadeService`,
         * which itself resolves the User's stored OAuth token via the
         * existing plugin-integration → social-sign-in chain. Committer
         * identity falls back to (Agent.committerName ?? Agent.name) /
         * (Agent.committerEmail ?? `<slug>@agents.ever.works`) when the
         * operator didn't explicitly set either column. The synthesized
         * email domain is a deliberate non-deliverable placeholder
         * until the Email Providers surface ships
         * (see docs/specs/features/email-providers/spec.md).
         */
        {
            provide: AGENT_GIT_FACADE,
            // Quality gates (audit W3 M3) — `PullRequestGateService` +
            // `WorkRepository` are APPENDED so `openPullRequest` can ask the
            // Work's checks policy before it opens anything. Appending keeps
            // the existing positional factory arguments untouched.
            //
            // APW-08 P0 — `MergePolicyService` is APPENDED for the same reason:
            // the protected-branch refusal is the Work's EFFECTIVE policy, so it
            // is read through the one service that already resolves that matrix
            // (four scopes, field-by-field) instead of being re-implemented here.
            inject: [
                GitFacadeService,
                AgentRepository,
                PullRequestGateService,
                WorkRepository,
                MergePolicyService,
            ],
            useFactory: (
                git: GitFacadeService,
                agents: AgentRepository,
                prGate: PullRequestGateService,
                works: WorkRepository,
                mergePolicy: MergePolicyService,
            ): AgentGitFacade => {
                /**
                 * APW-08 P0 — the repository an Agent git tool actually acts on.
                 *
                 * Provider id comes from the Work's OWN stored git provider and
                 * owner/repo from its repository record — the same source the rest
                 * of the platform reads (`work.gitProvider`,
                 * `work.getRepoOwner('website')`, `work.getWebsiteRepo()`; see
                 * `deploy.service.ts` §createDeployContext). A hardcoded provider
                 * and an empty owner/repo are both refusals now, not fallbacks.
                 *
                 * The ROLE is kind-aware on purpose. Every App Work persists its
                 * "Work Repository" under the `website` role, but a `repo` Work
                 * (EW-766) wraps an EXISTING code repository and declares
                 * `repos.website: false` — reaching for the `${slug}-website` name
                 * that kind never provisions would silently retarget the tool, so
                 * that kind resolves through `data`, which is the repositories
                 * record its guarantee is about. The kind-conditional question goes
                 * through `getWorkCapabilities()` rather than an inline
                 * `kind === 'directory'` test, per that registry's own rule.
                 */
                const resolveWorkGitTarget = async (tool: string, workId: string) => {
                    const work = await works.findById(workId);
                    if (!work) {
                        throw new Error(
                            `${tool}: Work ${workId} not found — cannot resolve its git provider, owner or repo.`,
                        );
                    }
                    const providerId = (work.gitProvider ?? '').trim();
                    if (!providerId) {
                        throw new Error(
                            `${tool}: Work ${workId} has no git provider configured. ` +
                                `Set the Work's git provider before committing or opening a pull request.`,
                        );
                    }
                    const role: RepositoryRole = getWorkCapabilities(work.kind).repos.website
                        ? 'website'
                        : 'data';
                    const owner = (work.getRepoOwner?.(role) ?? '').trim();
                    const repo = (
                        (role === 'website' ? work.getWebsiteRepo?.() : work.getDataRepo?.()) ?? ''
                    ).trim();
                    if (!owner || !repo) {
                        throw new Error(
                            `${tool}: could not resolve the Work's ${role} repository (owner/repo) for ` +
                                `Work ${workId} — refusing to act on an empty target.`,
                        );
                    }
                    return { work, providerId, owner, repo, role };
                };

                /**
                 * A caller that names a provider explicitly still wins — nothing
                 * that worked before is removed, the Work's provider is simply the
                 * default and this rides beside it. The Agent tool cannot use it to
                 * choose its own provider: its JSON schema declares no `providerId`,
                 * so the model never sends one.
                 */
                const explicitProviderIdOf = (input: unknown): string => {
                    const value = (input as { providerId?: unknown } | null)?.providerId;
                    return typeof value === 'string' ? value.trim() : '';
                };

                /**
                 * The protected branches for this Work: the built-in release floor ∪
                 * the Work's effective merge-policy `protectedBranches`. Never
                 * throws — a policy read that fails must not be the reason a
                 * protected branch becomes writable, so the floor stands alone.
                 */
                const resolveProtectedBranches = async (
                    workId: string,
                ): Promise<readonly string[]> => {
                    const branches: string[] = [...PROTECTED_RELEASE_BRANCHES];
                    try {
                        const resolved = await mergePolicy.resolve({ workId });
                        for (const branch of resolved?.policy?.protectedBranches ?? []) {
                            if (typeof branch === 'string' && branch.trim()) branches.push(branch);
                        }
                    } catch {
                        // Fail closed — `PROTECTED_RELEASE_BRANCHES` still applies.
                    }
                    return branches;
                };

                /**
                 * THROW (never return a boolean) when `branch` is protected — shaped
                 * like the push-failure path below, because the model needs the
                 * branch name and the reason to retry on a feature branch instead of
                 * retrying the same push.
                 */
                const assertNotProtectedBranch = (
                    tool: string,
                    branch: string,
                    protectedBranches: readonly string[],
                ): void => {
                    const normalized = normalizeBranchRef(branch);
                    const match = protectedBranches.find(
                        (entry) => normalizeBranchRef(entry) === normalized,
                    );
                    if (!match) return;
                    throw new Error(
                        `${tool}: refusing to commit to '${branch}' — '${match}' is a protected release branch ` +
                            `(protected: ${protectedBranches.join(', ')}). Agent pushes to a protected branch are ` +
                            `not allowed: commit to a feature branch and open a pull request into '${match}' instead.`,
                    );
                };

                /**
                 * The default branch the repository ACTUALLY has. The provider is
                 * asked first — its `default_branch` is the authoritative answer, and
                 * it needs no working copy, so a protected default can be refused
                 * before anything is cloned. The local clone is the fallback (it can
                 * only ever answer `main`/`master`). `null` means "cannot answer";
                 * callers decide whether that is a refusal.
                 */
                const readProviderDefaultBranch = async (
                    target: { providerId: string; owner: string; repo: string },
                    userId: string,
                    workId: string,
                ): Promise<string | null> => {
                    try {
                        const repository = await git.getRepository(target.owner, target.repo, {
                            providerId: target.providerId,
                            userId,
                            workId,
                        } as any);
                        return repository?.defaultBranch?.trim() || null;
                    } catch {
                        return null;
                    }
                };

                /** Fallback: the default branch the local working copy has. */
                const readLocalDefaultBranch = async (
                    providerId: string,
                    dir: string,
                ): Promise<string | null> => {
                    const local = await git.getMainBranch(providerId, dir).catch(() => null);
                    return typeof local === 'string' && local.trim() ? local.trim() : null;
                };

                /**
                 * The branch the working copy is BASED on (plan §2.2): the Work's
                 * declared `taskIsolationBaseBranch` when it has one — the column
                 * whose own contract is "where Task branches fork from; NULL = the
                 * repo's default branch" — else the repository's ACTUAL default
                 * branch. `''` means "not resolvable"; the caller then falls back to
                 * the fresh clone's own default, and refuses if that is silent too.
                 *
                 * Never a hardcoded `main`: a repository that has no `main` would be
                 * cloned from a branch that does not exist.
                 */
                const resolveBaseBranch = async (
                    target: {
                        work?: { taskIsolationBaseBranch?: string | null } | null;
                        providerId: string;
                        owner: string;
                        repo: string;
                    },
                    userId: string,
                    workId: string,
                ): Promise<string> => {
                    const declared = (target.work?.taskIsolationBaseBranch ?? '').trim();
                    if (declared) return declared;
                    return (await readProviderDefaultBranch(target, userId, workId)) ?? '';
                };

                /**
                 * The working copy for one Work: the Work's OWN repository — never
                 * the Work's import source, which is what the old repo-directory
                 * lookup cloned — in
                 * a directory of its own ({@link workCheckoutKey}), based on the
                 * resolved base branch and left ON that branch
                 * (`autoSwitchToMainBranch: false`), because the caller decides the
                 * branch it commits to.
                 */
                const openWorkCheckout = (
                    target: { owner: string; repo: string },
                    base: string,
                    providerId: string,
                    userId: string,
                    workId: string,
                ): Promise<string> =>
                    git.cloneOrPull(
                        {
                            owner: target.owner,
                            repo: target.repo,
                            // Absent means "whatever the repository's default is":
                            // the plugin clones with no `ref` rather than guessing.
                            ...(base ? { branch: base } : {}),
                            autoSwitchToMainBranch: false,
                            checkoutKey: workCheckoutKey(workId),
                        },
                        { providerId, userId, workId } as any,
                    );

                return {
                    async commitToRepo(input) {
                        const { userId, agentId, workId, message, files } = input;
                        const agent = await agents.findById(agentId);
                        if (!agent) {
                            throw new Error(`commitToRepo: agent ${agentId} not found.`);
                        }
                        // Resolve the Work's provider/owner/repo from the Work
                        // itself — the hardcoded provider this replaces made every
                        // non-GitHub Work unreachable, and the empty provider id that
                        // used to reach the old repo-directory lookup made that
                        // lookup throw, so the tool never got past its own guard.
                        const target = await resolveWorkGitTarget('commitToRepo', workId);
                        const providerId = explicitProviderIdOf(input) || target.providerId;

                        // APW-08 P0 — the branch the working copy is based on, then
                        // the branch the commit is TARGETED at: what the caller named,
                        // else that base. Both come from the Work, never from a
                        // literal — and a protected branch is refused BEFORE any git
                        // operation runs: nothing is cloned, switched, staged,
                        // committed or pushed.
                        const base = await resolveBaseBranch(target, userId, workId);
                        let branch = typeof input.branch === 'string' ? input.branch.trim() : '';
                        const namedTarget = branch || base;
                        if (namedTarget) {
                            assertNotProtectedBranch(
                                'commitToRepo',
                                namedTarget,
                                await resolveProtectedBranches(workId),
                            );
                        }

                        // APW-08 P0 (T2/T3) — everything that touches the working
                        // copy runs under the Work's commit slot, so a second commit
                        // for this Work cannot switch the checkout under the first
                        // one's push. The policy refusal above deliberately stays
                        // OUTSIDE: a refusal holds no slot and costs no wait.
                        return withWorkCommitLock(workId, async () => {
                            const dir = await openWorkCheckout(
                                target,
                                base,
                                providerId,
                                userId,
                                workId,
                            );
                            if (!branch) {
                                branch =
                                    base || ((await readLocalDefaultBranch(providerId, dir)) ?? '');
                                if (!branch) {
                                    throw new Error(
                                        `commitToRepo: could not resolve the default branch of ` +
                                            `${target.owner}/${target.repo} — pass an explicit \`branch\` instead.`,
                                    );
                                }
                                assertNotProtectedBranch(
                                    'commitToRepo',
                                    branch,
                                    await resolveProtectedBranches(workId),
                                );
                            }
                            // Stage any file edits provided inline. Empty `files`
                            // means "commit whatever earlier tool calls staged".
                            if (files && files.length > 0) {
                                const fsp = await import('node:fs/promises');
                                const path = await import('node:path');
                                // SECURITY: `f.path` is supplied verbatim by the LLM
                                // tool call (potentially prompt-injected via hostile
                                // repo/web content) and is NOT validated upstream.
                                // Confine every write to the cloned repo `dir` —
                                // mirroring `resolveSandboxPath`
                                // (packages/plugins/agent-pipeline/src/tools/file-tools.ts):
                                // reject absolute paths and reject any relative path
                                // whose resolved target escapes `dir` (e.g.
                                // `../../.ssh/authorized_keys`). Without this, the
                                // recursive mkdir + writeFile below would create and
                                // overwrite arbitrary files outside the repo on the
                                // shared worker filesystem (path traversal / zip-slip).
                                const repoRoot = path.resolve(dir);
                                for (const f of files) {
                                    if (
                                        typeof f.path !== 'string' ||
                                        f.path.length === 0 ||
                                        path.isAbsolute(f.path)
                                    ) {
                                        throw new Error(
                                            `commitToRepo: invalid file path ${JSON.stringify(
                                                f.path,
                                            )} — must be a non-empty path relative to the repo root.`,
                                        );
                                    }
                                    const abs = path.resolve(repoRoot, f.path);
                                    if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) {
                                        throw new Error(
                                            `commitToRepo: file path ${JSON.stringify(
                                                f.path,
                                            )} resolves outside the repo directory — refusing to write.`,
                                        );
                                    }
                                    await fsp.mkdir(path.dirname(abs), { recursive: true });
                                    await fsp.writeFile(abs, f.body, 'utf8');
                                }
                                // Stage EXACTLY the paths written above. isomorphic-git
                                // commits the INDEX, not the working copy, and this tool
                                // never staged: every file it wrote stayed unstaged,
                                // `git.commit` found nothing to commit and returned
                                // `null`, the push sent nothing new, and the tool still
                                // answered `filesChanged: N`. Reproduced against the real
                                // library: commit without add -> null; with add -> a sha.
                                //
                                // Only these paths, not `addAll`: the working copy is
                                // shared per Work, and sweeping in whatever else is dirty
                                // would commit changes nobody asked this call to make.
                                await git.add(
                                    providerId,
                                    dir,
                                    files.map((f) => f.path),
                                );
                            }
                            const committerName = agent.committerName ?? agent.name;
                            const committerEmail =
                                agent.committerEmail ?? `${agent.slug}@agents.ever.works`;
                            // APW-08 P0 — the branch is threaded into the commit itself.
                            // The commit used to land on whatever branch the clone
                            // happened to be on while the tool RETURNED `branch ?? 'main'`
                            // — a branch it had never committed to. Check the branch out
                            // (creating it if the Agent is starting a new one) so the
                            // committed branch and the returned branch are the same
                            // branch, by construction.
                            await git.switchBranch(providerId, dir, branch, true);
                            const sha = await git.commit(providerId, dir, message, {
                                name: committerName,
                                email: committerEmail,
                            } as any);
                            // APW-08 P0 — the push NAMES the branch (`ref` /
                            // `remoteRef`), so the remote receives the branch we
                            // committed to instead of "whatever HEAD is at push
                            // time", which is how a commit could silently go
                            // nowhere while the tool reported success.
                            await git
                                .push({ dir, force: false, ref: branch, remoteRef: branch }, {
                                    providerId,
                                    userId,
                                    workId,
                                } as any)
                                .catch((err: Error) => {
                                    // Don't swallow push failures silently — the
                                    // model needs to know its commit didn't reach
                                    // the remote so it can retry or escalate.
                                    throw new Error(
                                        `commitToRepo: push failed (${err.message ?? err}).`,
                                    );
                                });
                            return {
                                sha: sha ?? null,
                                branch,
                                // No commit, no changed files. `null` from `commit` means
                                // nothing was staged — e.g. every file was written with
                                // the content it already had — and reporting N changed
                                // files for it is how the old no-op looked like success.
                                filesChanged: sha ? (files?.length ?? 0) : 0,
                            };
                        });
                    },
                    async openPullRequest(input) {
                        const { userId, workId, title, body, draft } = input;
                        void input.agentId;
                        // APW-08 P0 — the pull request names a REAL target. It used to
                        // pass `owner: ''` / `repo: ''`, which is not a repository:
                        // the provider call could only fail (or, worse, succeed
                        // somewhere nobody asked for). Both now come from the Work.
                        //
                        // Deliberately NOT refused for a protected `base`: opening a
                        // pull request INTO `main` is what a protected `main` is for.
                        // The push is the thing that is refused — in `commitToRepo`.
                        const target = await resolveWorkGitTarget('openPullRequest', workId);
                        const providerId = explicitProviderIdOf(input) || target.providerId;
                        // APW-08 P0 — `base` defaults to the Work's base branch (its
                        // declared `taskIsolationBaseBranch`, else the repository's
                        // default), instead of the hardcoded 'main' a repository may
                        // not even have. An explicit base still wins, unchanged. It is
                        // resolved BEFORE the checkout below because the checkout is
                        // the gate's `cwd`: the gate has to run against the branch the
                        // pull request is actually based on.
                        let base = typeof input.base === 'string' ? input.base.trim() : '';
                        if (!base) base = await resolveBaseBranch(target, userId, workId);
                        // Quality gates (audit W3 M3) — "a red check opens no PR"
                        // holds for the Agent tool too. `assertAllowed` THROWS on
                        // a refusal, which is the right shape here: the tool's
                        // contract is "return a pull request", so the refusal
                        // (and its reason) reaches the model instead of a
                        // fabricated success. A Work with the default
                        // `checksPolicy: 'off'` short-circuits before any
                        // subprocess or checkout resolution.
                        //
                        // APW-08 P0 (T3) — the checkout is the Work's OWN repository,
                        // in the same per-Work working copy `commitToRepo` uses
                        // ({@link workCheckoutKey}); the old repo-directory lookup
                        // cloned the Work's IMPORT source and is gone from this
                        // adapter — no git call in it resolves a directory any more.
                        const gateCwd = await openWorkCheckout(
                            target,
                            base,
                            providerId,
                            userId,
                            workId,
                        ).catch(() => null);
                        await prGate.assertAllowed({
                            work: target.work,
                            cwd: gateCwd,
                            context: `agent-tool openPullRequest work=${workId}`,
                        });
                        if (!base) {
                            base =
                                (gateCwd
                                    ? await readLocalDefaultBranch(providerId, gateCwd)
                                    : null) ?? '';
                        }
                        if (!base) {
                            throw new Error(
                                `openPullRequest: could not resolve the base branch of ` +
                                    `${target.owner}/${target.repo} — pass an explicit \`base\`.`,
                            );
                        }
                        // APW-08 P0 (T4) — the head branch must EXIST before a pull
                        // request names it (FR-5, ACC-08-04). A head the repository
                        // does not have is a promise the platform cannot keep: the
                        // provider refuses the call, or — worse — someone opens a
                        // pull request nobody asked for from a branch the Agent
                        // never pushed. `listBranches` is the provider's OWN answer,
                        // the same REQUIRED capability `release-promotion.service.ts`
                        // verifies both of its branches against, and a branch list
                        // that cannot be read is a refusal too — never a silent
                        // "assume it exists".
                        const head = (input.head ?? '').trim();
                        const branches = await git
                            .listBranches(target.owner, target.repo, {
                                providerId,
                                userId,
                                workId,
                            } as any)
                            .catch((err: Error) => {
                                throw new Error(
                                    `openPullRequest: could not read the branches of ` +
                                        `${target.owner}/${target.repo} to verify the head branch ` +
                                        `'${head}' (${err?.message ?? err}).`,
                                );
                            });
                        if (!branches.some((branch) => branch?.name === head)) {
                            throw new Error(
                                `openPullRequest: head branch '${head}' does not exist in ` +
                                    `${target.owner}/${target.repo}. Push the branch before opening a pull request.`,
                            );
                        }
                        const pr = await git.createPullRequest(
                            {
                                owner: target.owner,
                                repo: target.repo,
                                title,
                                body,
                                // The head that was VERIFIED is the head that is
                                // opened — one value, resolved once.
                                head,
                                base,
                                draft: draft ?? false,
                            } as any,
                            { providerId, userId, workId } as any,
                        );
                        return {
                            number: pr.number,
                            url: pr.url,
                            state: (pr.state ?? 'open') as 'open' | 'closed' | 'merged' | 'draft',
                        };
                    },
                };
            },
        },
        // Notifications v2 (EW-670) — AGENT_EMAIL_FACADE binding. Routes
        // the `sendEmail` + `messageAgent` Agent tools through the
        // api-side EmailService (which resolves the agent's outbound
        // address + persists the message + records usage). `messageAgent`
        // resolves the TARGET agent's primary inbound address, then sends
        // from the sender's outbound — the inbound dispatcher routes it
        // into a conversation thread on arrival.
        {
            provide: AGENT_EMAIL_FACADE,
            inject: [
                EmailService,
                AgentEmailAssignmentRepository,
                TenantEmailAddressRepository,
                AgentRepository,
            ],
            useFactory: (
                email: EmailService,
                assignments: AgentEmailAssignmentRepository,
                addresses: TenantEmailAddressRepository,
                agents: AgentRepository,
            ): AgentEmailFacade => ({
                async sendEmail({
                    userId,
                    agentId,
                    to,
                    cc,
                    subject,
                    bodyText,
                    bodyHtml,
                    template,
                    fromAddressId,
                }) {
                    // AW-05 — `origin: 'agent'`: this is the Agent writing, so
                    // its inbox's approve-before-send mode applies (a person
                    // composing goes through the controller as `human`).
                    const result = await email.sendMessage(
                        userId,
                        {
                            agentId,
                            to: [...to],
                            cc: cc ? [...cc] : undefined,
                            subject,
                            bodyText,
                            bodyHtml,
                            template,
                            fromAddressId,
                        },
                        { origin: 'agent' },
                    );
                    if (result.held) {
                        return {
                            providerMessageId: '',
                            accepted: [],
                            rejected: [],
                            held: true,
                            messageId: result.messageId,
                            note: HELD_FOR_APPROVAL_NOTE,
                        };
                    }
                    return {
                        providerMessageId: result.providerMessageId,
                        accepted: [...result.accepted],
                        rejected: result.rejected.map((r) => ({ ...r })),
                    };
                },
                async messageAgent({ userId, fromAgentId, targetAgentId, subject, body }) {
                    // Security: `targetAgentId` is supplied verbatim by the LLM
                    // tool call (potentially prompt-injected) and is otherwise
                    // unscoped — `assignments.findByAgent` queries by agentId
                    // alone. Without this check an agent on one tenant could
                    // pass another tenant's agent UUID to leak that agent's
                    // inbound address (returned as `targetAddress`) and deliver
                    // an unsolicited message to it (cross-tenant IDOR). Confine
                    // the target to an Agent owned by the calling `userId` —
                    // same ownership boundary as the outbound from-address
                    // scoping in EmailService.sendMessage.
                    const target = await agents.findByIdAndUser(targetAgentId, userId);
                    if (!target) {
                        throw new Error(`messageAgent: target agent ${targetAgentId} not found.`);
                    }
                    const inbound = await assignments.findByAgent(targetAgentId, 'inbound');
                    const assignment = inbound[0];
                    if (!assignment) {
                        throw new Error(
                            `messageAgent: target agent ${targetAgentId} has no inbound email address.`,
                        );
                    }
                    const address = await addresses.findById(assignment.emailAddressId);
                    if (!address) {
                        throw new Error('messageAgent: target inbound address not found.');
                    }
                    const result = await email.sendMessage(
                        userId,
                        {
                            agentId: fromAgentId,
                            to: [address.address],
                            subject,
                            bodyText: body,
                        },
                        { origin: 'agent' },
                    );
                    if (result.held) {
                        return {
                            providerMessageId: '',
                            targetAddress: address.address,
                            held: true,
                            messageId: result.messageId,
                            note: HELD_FOR_APPROVAL_NOTE,
                        };
                    }
                    return {
                        providerMessageId: result.providerMessageId,
                        targetAddress: address.address,
                    };
                },
            }),
        },
        // Notifications v2 (EW-673) — AGENT_NOTIFY_CHANNEL_FACADE binding.
        // Routes the `notifyChannel` Agent tool through
        // NotificationChannelFacadeService.sendDirect; listEnabledChannels
        // reads the user's active channels for the model to choose from.
        {
            provide: AGENT_NOTIFY_CHANNEL_FACADE,
            inject: [NotificationChannelFacadeService, NotificationChannelRepository],
            useFactory: (
                channels: NotificationChannelFacadeService,
                channelRepo: NotificationChannelRepository,
            ): AgentNotifyChannelFacade => ({
                async notifyChannel({ userId, agentId, channelId, text }) {
                    const result = await channels.sendDirect(
                        channelId,
                        { text, messageRef: `agent-${agentId}-${Date.now()}` },
                        { userId, agentId },
                    );
                    // sendDirect is the synchronous inline path (no Trigger
                    // dispatch), so it only ever resolves delivered/failed —
                    // narrow the facade's wider union for the agent tool.
                    return {
                        status: result.status === 'failed' ? 'failed' : 'delivered',
                        providerMessageId: result.providerMessageId,
                        error: result.error,
                    };
                },
                async listEnabledChannels(userId) {
                    const rows = await channelRepo.findActiveByUser(userId);
                    return rows.map((c) => ({ id: c.id, name: c.name, pluginId: c.pluginId }));
                },
            }),
        },
        // Domain chat tools — AGENT_DOMAIN_TOOL_SOURCES binding.
        //
        // Six descriptor factories shipped with their domains (Waves 3,
        // 6, 7, 8, 12) but nothing ever handed them their services, so
        // no agent run could call them. This is the binding that closes
        // that gap: it carries ONLY the backing services, and
        // `AgentToolService.resolveAllowedTools` builds + permission-gates
        // the descriptors — the single tool-assembly point the run loop
        // already reads from. Same @Global() token posture as the facade
        // bindings above, so the @Optional() injection in the agent-side
        // AgentsModule actually resolves in production.
        {
            provide: AGENT_DOMAIN_TOOL_SOURCES,
            inject: [
                TasksService,
                TaskChatService,
                TaskAssigneeRepository,
                TaskReviewerRepository,
                TaskApproverRepository,
                IngestedEventRepository,
                DigestService,
                MeetingRepository,
                FleetService,
                PrReviewService,
                MergePolicyService,
                WorkOwnershipService,
                AgentRepository,
                BrowserAutomationFacadeService,
                AgentEscalationService,
                ToolGrantService,
                WorkflowGraphExecutorService,
                InboxService,
                // Reviewer agent stage (slice AD, EW-811) — backs
                // `submitTaskReview`. APPENDED LAST, and matched by the
                // last parameter of `useFactory` below: this list is
                // positional and the container passes it positionally, so
                // inserting anywhere else silently rebinds every service
                // after the insertion point.
                TaskAgentReviewService,
            ],
            useFactory: (
                tasksService: TasksService,
                chatService: TaskChatService,
                assignees: TaskAssigneeRepository,
                reviewers: TaskReviewerRepository,
                approvers: TaskApproverRepository,
                ingestedEvents: IngestedEventRepository,
                digest: DigestService,
                meetings: MeetingRepository,
                fleet: FleetService,
                prReview: PrReviewService,
                mergePolicy: MergePolicyService,
                workOwnership: WorkOwnershipService,
                agents: AgentRepository,
                browser: BrowserAutomationFacadeService,
                escalationService: AgentEscalationService,
                toolGrants: ToolGrantService,
                workflowExecutor: WorkflowGraphExecutorService,
                inboxService: InboxService,
                agentReviews: TaskAgentReviewService,
            ): AgentDomainToolSources => ({
                // All three membership repositories are bound: the
                // commentOnTask gate is fail-closed and DENIES every call
                // when any of them is missing.
                tasks: {
                    tasksService,
                    chatService,
                    assignees,
                    reviewers,
                    approvers,
                    // Reviewer agent stage (slice AD, EW-811). Unbound,
                    // `submitTaskReview` is not offered at all and no
                    // agent approval can be recorded — the same
                    // fail-closed posture as the membership repositories
                    // above.
                    agentReviews,
                },
                ingest: { repository: ingestedEvents },
                digest: { digestService: digest },
                meetings: { repository: meetings },
                fleet: { service: fleet },
                // Audit G22 — headless browsing. Only `read` is passed, so the
                // capability's page-driving `act` is unreachable from chat.
                browser: { facade: browser },
                prReview: { prReviewService: prReview },
                mergePolicy: {
                    service: mergePolicy,
                    // Security: the model supplies workId/agentId, so both
                    // are owner-checked BEFORE any resolution runs —
                    // otherwise the tool is a cross-tenant policy oracle.
                    // Mirrors `MergePolicyController.resolve` exactly;
                    // returning null (rather than throwing) lets the tool
                    // answer "not found or not accessible" with no
                    // existence leak.
                    async authorize(userId, input) {
                        if (input.workId) {
                            try {
                                await workOwnership.ensureAccess(input.workId, userId);
                            } catch {
                                return null;
                            }
                        }
                        if (input.agentId) {
                            const agent = await agents.findByIdAndUser(input.agentId, userId);
                            if (!agent) return null;
                        }
                        return {
                            workId: input.workId ?? null,
                            agentId: input.agentId ?? null,
                        };
                    },
                },
                // Judgment layer G3/G10 — the escalation queue. Owner
                // scope is closed inside the service (every read/write
                // takes the agent owner's userId), so unlike merge-policy
                // there is no model-supplied id to authorize.
                escalations: { service: escalationService },
                // Tool-grant matrix (audit item G4) — the read-only grant
                // chat tools. Same owner-check posture as the merge-policy
                // source above: the ids come from the MODEL, so both are
                // verified against the acting user before any resolution,
                // and a foreign id returns null (no existence leak).
                toolGrants: {
                    service: toolGrants,
                    async authorize(userId, input) {
                        if (input.workId) {
                            try {
                                await workOwnership.ensureAccess(input.workId, userId);
                            } catch {
                                return null;
                            }
                        }
                        if (input.agentId) {
                            const agent = await agents.findByIdAndUser(input.agentId, userId);
                            if (!agent) return null;
                        }
                        return {
                            userId,
                            workId: input.workId ?? null,
                            agentId: input.agentId ?? null,
                        };
                    },
                },
                // Judgment layer G5 — workflow graphs. Binding this is what
                // finally gives `WorkflowGraphExecutorService` a production
                // caller: it has been complete and DI-wired for a while,
                // with its node runner bound in `TasksModule`, yet nothing
                // ever invoked `execute()`.
                //
                // No `authorize` hook, unlike merge-policy and tool-grants:
                // the model supplies no ids here. The graph's entire
                // authority comes from the Agent row, assembled in
                // `buildDomainTools`, and the tool schema has no parameter
                // that could carry one.
                workflow: { executor: workflowExecutor },
                // Inbox (operator message center) — the `ask_human`
                // blocking-question tool, available to every agent (no
                // permission gate: asking is always safe). Only
                // `askHuman` is carried, so the reply router and list
                // surface are unreachable from the model.
                inbox: { service: inboxService },
            }),
        },
        // Agent Plugins MCP slice (T26) — AGENT_MCP_TOOL_SOURCE binding.
        // `AgentToolService.resolveGrantedTools` injects this @Optional();
        // without the binding no run would ever see an MCP tool, exactly
        // the dead-seam failure mode this module's pin spec exists to
        // catch. `useExisting` so the McpModule-provided singleton (with
        // its listTools TTL cache) is shared with the HTTP surface.
        { provide: AGENT_MCP_TOOL_SOURCE, useExisting: McpToolSource },
        // Skill files — expose the uploads-spine reader to the agent-side
        // AgentToolService (@Optional() @Inject(SKILL_FILE_CONTENT_READER)).
        // Unbound, `getSkillFile` would list files but refuse every read.
        { provide: SKILL_FILE_CONTENT_READER, useExisting: SkillFileContentReaderService },
        // AW-20 P1 — the seam roster provisioning attaches Skills through.
        // `@Optional()` at the consumer, so WITHOUT this binding a roster
        // is still provisioned and wired, just without its suggested
        // Skills — the same dead-seam trap every other binding here
        // documents.
        RosterSkillBinderAdapter,
        { provide: ROSTER_SKILL_BINDER, useExisting: RosterSkillBinderAdapter },
    ],
    exports: [
        SKILL_FILE_CONTENT_READER,
        ROSTER_SKILL_BINDER,
        AGENT_HEARTBEAT_TRIGGER,
        // Goals autonomy layer — GoalOrchestratorService cancels the Goal's
        // in-flight iteration run and needs the SAME remote cancel this
        // module's own `cancelRun` endpoint uses. @Global() only publishes
        // EXPORTED providers, so an unexported token resolves to `undefined`
        // at the @Optional() consumer and the remote half silently degrades
        // to a DB-only cancel (the exact failure agent-run-canceller.ts's
        // docblock was written about).
        AGENT_RUN_CANCELLER,
        AGENT_RUN_CHAT_BACK_POSTER,
        AGENT_RUN_CONVERSATION_REPLY_POSTER,
        AGENT_RUN_TASK_FINISHER,
        AGENT_PLUGIN_TOOLS_FACADE,
        AGENT_AI_DISPATCH_FACADE,
        AGENT_GIT_FACADE,
        AGENT_EMAIL_FACADE,
        AGENT_NOTIFY_CHANNEL_FACADE,
        AGENT_DOMAIN_TOOL_SOURCES,
        AGENT_MCP_TOOL_SOURCE,
        INBOUND_EMAIL_TASK_SPAWNER,
        RUN_STEERING_PORT,
        TERMINAL_SESSION_DISPATCHER,
        TERMINAL_SESSION_STARTER,
        RUN_KILL_SWITCH,
        SAFETY_GATE,
    ],
})
export class AgentsModule {}
