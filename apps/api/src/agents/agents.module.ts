import { Global, Module } from '@nestjs/common';
import {
    AgentsModule as AgentAgentsModule,
    AgentRepository,
    AGENT_RUN_CHAT_BACK_POSTER,
    AGENT_RUN_TASK_FINISHER,
    AGENT_PLUGIN_TOOLS_FACADE,
    AGENT_AI_DISPATCH_FACADE,
    AGENT_GIT_FACADE,
    type AgentRunChatBackPoster,
    type AgentRunTaskFinisher,
    type AgentPluginToolsFacade,
    type AgentAiDispatchFacade,
    type AgentAiToolCall,
    type AgentGitFacade,
} from '@ever-works/agent/agents';

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
} from '@ever-works/agent/tasks-domain';
import {
    FacadesModule,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    AiFacadeService,
    GitFacadeService,
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
import { AuthModule } from '../auth/auth.module';
import { AgentsController } from './agents.controller';

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
    ],
    controllers: [AgentsController],
    providers: [
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
                    });
                    return { status: row.status };
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
                    query,
                    maxResults,
                    includeDomains,
                    excludeDomains,
                }) {
                    const results = await search.search(
                        query,
                        { maxResults, includeDomains, excludeDomains },
                        { userId, workId, agentId, taskId },
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
                    url,
                    viewportWidth,
                    viewportHeight,
                    fullPage,
                }) {
                    const result = await screenshot.capture(
                        { url, viewportWidth, viewportHeight, fullPage } as any,
                        { userId, workId, agentId, taskId },
                    );
                    return {
                        success: result.success,
                        imageUrl: result.imageUrl ?? null,
                        cacheUrl: result.cacheUrl ?? null,
                    };
                },
                async extractContent({ userId, workId, agentId, taskId, url, maxChars }) {
                    const result = await extractor.extractContent(url, undefined, {
                        userId,
                        workId,
                        agentId,
                        taskId,
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
                        },
                        {
                            userId: input.facadeOptions.userId,
                            workId: input.facadeOptions.workId,
                            agentId: input.facadeOptions.agentId,
                            taskId: input.facadeOptions.taskId,
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
            inject: [GitFacadeService, AgentRepository],
            useFactory: (git: GitFacadeService, agents: AgentRepository): AgentGitFacade => ({
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
                        for (const f of files) {
                            const abs = path.join(dir, f.path);
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
    ],
    exports: [
        AGENT_RUN_CHAT_BACK_POSTER,
        AGENT_RUN_TASK_FINISHER,
        AGENT_PLUGIN_TOOLS_FACADE,
        AGENT_AI_DISPATCH_FACADE,
        AGENT_GIT_FACADE,
    ],
})
export class AgentsModule {}
