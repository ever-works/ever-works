import { Global, Module } from '@nestjs/common';
import {
    AgentsModule as AgentAgentsModule,
    AgentRepository,
    AGENT_HEARTBEAT_TRIGGER,
    AGENT_RUN_CANCELLER,
    AGENT_RUN_CHAT_BACK_POSTER,
    AGENT_RUN_TASK_FINISHER,
    AGENT_PLUGIN_TOOLS_FACADE,
    AGENT_AI_DISPATCH_FACADE,
    AGENT_GIT_FACADE,
    AGENT_EMAIL_FACADE,
    AGENT_NOTIFY_CHANNEL_FACADE,
    AGENT_DOMAIN_TOOL_SOURCES,
    AGENT_MCP_TOOL_SOURCE,
    AgentEscalationService,
    RunSteeringService,
    WorkflowGraphExecutorService,
    type AgentDomainToolSources,
    TERMINAL_SESSION_DISPATCHER,
    TerminalSessionLauncher,
    type AgentRunChatBackPoster,
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
import { FleetModule, FleetService } from '@ever-works/agent/fleet';
import { PrReviewModule, PrReviewService } from '@ever-works/agent/pr-review';
import {
    PolicyModule,
    MergePolicyService,
    PullRequestGateService,
    ToolGrantService,
} from '@ever-works/agent/policy';
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
// ActivityLogService is injected @Optional() into AgentsController for
// the lifecycle trail (AGENT_PAUSED / AGENT_RESUMED / run-triggered /
// run-cancelled / task-assigned) and the GET :id/events feed. Without
// this import the optional injection silently resolved to `undefined`
// and every tryLog() was a no-op — same wiring as works/plugins/auth.
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';
import { AgentCollaboratorsController } from './agent-collaborators.controller';
import { AgentTemplatesController } from './agent-templates.controller';
import { AgentTemplateCatalogService } from './agent-template-catalog.service';

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
        // Agent Plugins MCP slice — provides McpToolSource for the
        // AGENT_MCP_TOOL_SOURCE binding below. Imports nothing api-side,
        // so no cycle is introduced.
        McpModule,
        AgentInboxModule,
    ],
    controllers: [AgentsController, AgentCollaboratorsController, AgentTemplatesController],
    providers: [
        AgentTemplateCatalogService,
        // Security: provided LOCALLY (not exported) so the merge-policy
        // chat tool's owner check runs the same `ensureAccess` gate the
        // HTTP surface does. Its deps (WorkRepository / WorkMemberRepository)
        // come from the DatabaseModule import above.
        WorkOwnershipService,
        { provide: AGENT_HEARTBEAT_TRIGGER, useValue: agentHeartbeatTriggerAdapter },
        {
            provide: AGENT_RUN_CANCELLER,
            inject: [TriggerService],
            useFactory: createAgentRunCancellerAdapter,
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
                    query,
                    maxResults,
                    includeDomains,
                    excludeDomains,
                }) {
                    const results = await search.search(
                        query,
                        { maxResults, includeDomains, excludeDomains },
                        // Wave 9 M2 — runId feeds per-run cost attribution.
                        { userId, workId, agentId, taskId, runId },
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
                    url,
                    viewportWidth,
                    viewportHeight,
                    fullPage,
                }) {
                    const result = await screenshot.capture(
                        { url, viewportWidth, viewportHeight, fullPage } as any,
                        // Wave 9 M2 — runId feeds per-run cost attribution.
                        { userId, workId, agentId, taskId, runId },
                    );
                    return {
                        success: result.success,
                        imageUrl: result.imageUrl ?? null,
                        cacheUrl: result.cacheUrl ?? null,
                    };
                },
                async extractContent({ userId, workId, agentId, taskId, runId, url, maxChars }) {
                    const result = await extractor.extractContent(url, undefined, {
                        userId,
                        workId,
                        agentId,
                        taskId,
                        // Wave 9 M2 — runId feeds per-run cost attribution.
                        runId,
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
        // FU-13 — AGENT_GIT_FACADE binding. Routes `commitToRepo` +
        // `openPullRequest` Agent tools through `GitFacadeService`,
        // which itself resolves the User's stored OAuth token via the
        // existing plugin-integration → social-sign-in chain. Committer
        // identity falls back to (Agent.committerName ?? Agent.name) /
        // (Agent.committerEmail ?? `<slug>@agents.ever.works`) when the
        // operator didn't explicitly set either column. The synthesized
        // email domain is a deliberate non-deliverable placeholder
        // until the Email Providers surface ships
        // (see docs/specs/features/email-providers/spec.md).
        {
            provide: AGENT_GIT_FACADE,
            // Quality gates (audit W3 M3) — `PullRequestGateService` +
            // `WorkRepository` are APPENDED so `openPullRequest` can ask the
            // Work's checks policy before it opens anything. Appending keeps
            // the existing positional factory arguments untouched.
            inject: [GitFacadeService, AgentRepository, PullRequestGateService, WorkRepository],
            useFactory: (
                git: GitFacadeService,
                agents: AgentRepository,
                prGate: PullRequestGateService,
                works: WorkRepository,
            ): AgentGitFacade => ({
                async commitToRepo({ userId, agentId, workId, message, files, branch }) {
                    const agent = await agents.findById(agentId);
                    if (!agent) {
                        throw new Error(`commitToRepo: agent ${agentId} not found.`);
                    }
                    const dir = await git.getRepoDir('work', workId, {
                        userId,
                        workId,
                        providerId: '',
                    } as any);
                    if (!dir) {
                        throw new Error(
                            'commitToRepo: could not resolve Work repo directory (Work missing or git provider unconfigured).',
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
                    }
                    const committerName = agent.committerName ?? agent.name;
                    const committerEmail =
                        agent.committerEmail ?? `${agent.slug}@agents.ever.works`;
                    // Find provider id from the Work's gitProvider via
                    // getRepoDir's transitive lookup — here we accept it
                    // from the agent's settings or default to 'github'
                    // which is the most common case.
                    const providerId = 'github';
                    const sha = await git.commit(providerId, dir, message, {
                        name: committerName,
                        email: committerEmail,
                    } as any);
                    await git
                        .push({ dir, force: false }, { providerId, userId, workId } as any)
                        .catch((err: Error) => {
                            // Don't swallow push failures silently — the
                            // model needs to know its commit didn't reach
                            // the remote so it can retry or escalate.
                            throw new Error(`commitToRepo: push failed (${err.message ?? err}).`);
                        });
                    return {
                        sha: sha ?? null,
                        branch: branch ?? 'main',
                        filesChanged: files?.length ?? 0,
                    };
                },
                async openPullRequest({ userId, agentId, workId, title, body, head, base, draft }) {
                    void agentId;
                    const providerId = 'github';
                    // Quality gates (audit W3 M3) — "a red check opens no PR"
                    // holds for the Agent tool too. `assertAllowed` THROWS on
                    // a refusal, which is the right shape here: the tool's
                    // contract is "return a pull request", so the refusal
                    // (and its reason) reaches the model instead of a
                    // fabricated success. A Work with the default
                    // `checksPolicy: 'off'` short-circuits before any
                    // subprocess or checkout resolution.
                    const work = await works.findById(workId);
                    const gateCwd = work
                        ? await git
                              .getRepoDir('work', workId, {
                                  userId,
                                  workId,
                                  providerId,
                              } as any)
                              .catch(() => null)
                        : null;
                    await prGate.assertAllowed({
                        work,
                        cwd: gateCwd,
                        context: `agent-tool openPullRequest work=${workId}`,
                    });
                    const pr = await git.createPullRequest(
                        {
                            owner: '',
                            repo: '',
                            title,
                            body,
                            head,
                            base: base ?? 'main',
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
            }),
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
                    const result = await email.sendMessage(userId, {
                        agentId,
                        to: [...to],
                        cc: cc ? [...cc] : undefined,
                        subject,
                        bodyText,
                        bodyHtml,
                        template,
                        fromAddressId,
                    });
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
                    const result = await email.sendMessage(userId, {
                        agentId: fromAgentId,
                        to: [address.address],
                        subject,
                        bodyText: body,
                    });
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
            ): AgentDomainToolSources => ({
                // All three membership repositories are bound: the
                // commentOnTask gate is fail-closed and DENIES every call
                // when any of them is missing.
                tasks: { tasksService, chatService, assignees, reviewers, approvers },
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
    ],
    exports: [
        AGENT_HEARTBEAT_TRIGGER,
        AGENT_RUN_CHAT_BACK_POSTER,
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
    ],
})
export class AgentsModule {}
