import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Agent, AgentPermissions } from '../entities/agent.entity';
import {
    AgentAvatarMode,
    AgentScope,
    AgentStatus,
    AGENT_PERMISSIONS_DEFAULT,
} from '../entities/agent.entity';
import { AgentRepository } from '../database/repositories/agent.repository';
import { AgentFileService } from './agent-file.service';
import { AgentsService } from './agents.service';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { SkillRepository } from '../database/repositories/skill.repository';
import { createGetSkillBodyTool } from './agent-tools-skill';
import {
    AGENT_GIT_FACADE,
    type AgentGitFacade,
    type AgentCommitToRepoResult,
    type AgentOpenPullRequestResult,
} from './agent-git-facade';
import {
    AGENT_PLUGIN_TOOLS_FACADE,
    type AgentPluginToolsFacade,
    type AgentSearchWebResult,
    type AgentScreenshotResult,
    type AgentExtractContentResult,
} from './agent-plugin-tools-facade';

/**
 * Tool descriptor — stable shape across every Agent tool. The
 * `invoke` callback is bound to the resolved context at descriptor-
 * build time, so callers (the AiFacadeService tool-loop wrapper)
 * don't need to thread the user/agent/scope ids back in.
 */
/**
 * JSON-Schema-ish property type — extended in Review-fix C5 to
 * carry `items` (for arrays) and a richer `type` union so LLMs
 * generating tool calls receive the correct JSON-Schema type tag
 * for each parameter. Previously every parameter was typed
 * `'string'` even when the runtime expected a number / boolean /
 * array — LLMs honor schema types when serializing, so this
 * mismatch sent strings into number-typed adapter fields.
 */
export interface AgentToolParameterSchema {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    description: string;
    items?: { type: 'string' | 'number' | 'integer' | 'boolean' | 'object' };
}

export interface AgentToolDescriptor<TArgs = unknown, TResult = unknown> {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, AgentToolParameterSchema>;
        required: string[];
    };
    invoke: (args: TArgs) => Promise<TResult | { error: string }>;
}

/**
 * Tasks/Tools feature — Phase 16.1.
 *
 * Resolves the per-run allow-list of tools an Agent can call, per
 * `agent-tools-catalog.md §4`. The Agent's `permissions` JSON and
 * `TOOLS.md` body both gate the surface — permissions denylist
 * (canCommitToRepo / canOpenPullRequests / canCallExternalTools /
 * canAssignTasks / canCreateAgents / canEditAgentFiles) wins; an
 * empty TOOLS.md does NOT exclude permitted tools (the file is a
 * model hint, not a security boundary).
 *
 * v1 ships descriptors for the 5 agent-internal tools that don't
 * need external plugins or git access:
 *   - getSkillBody          (Phase 10.3, re-exported here)
 *   - editAgentFile         (Phase 16.5 — re-uses AgentFileService.write)
 *   - createSubAgent        (Phase 16.8 — sub-Agents always in DRAFT,
 *                            permissions all false)
 *   - getActivity           (Phase 16.9 — placeholder hook)
 *   - getKbDocument         (Phase 16.9 — placeholder hook)
 *
 * createTask / commentOnTask / transitionTask / commitToRepo /
 * openPullRequest + the plugin pass-throughs (searchWeb /
 * screenshot / extractContent) wire in once their respective
 * platform surfaces are reachable from the agent package (the
 * facades are circular-dep-sensitive — we'll inject them via the
 * tool-loop wrapper in `AiFacadeService` rather than here).
 */
@Injectable()
export class AgentToolService {
    private readonly logger = new Logger(AgentToolService.name);

    constructor(
        private readonly agents: AgentRepository,
        @Optional() private readonly skills?: SkillRepository,
        @Optional() private readonly bindings?: SkillBindingRepository,
        @Optional() private readonly files?: AgentFileService,
        @Optional()
        @Inject(AGENT_GIT_FACADE)
        private readonly git?: AgentGitFacade,
        @Optional()
        @Inject(AGENT_PLUGIN_TOOLS_FACADE)
        private readonly pluginTools?: AgentPluginToolsFacade,
        // Review-fix I6: route createSubAgent through AgentsService so
        // scope-ownership validation + slug-uniqueness + avatar-field
        // validation + permission refinement all run, instead of the
        // raw repository.create that bypassed everything. Optional()
        // keeps unit tests that mock only AgentRepository working.
        @Optional() private readonly agentsService?: AgentsService,
    ) {}

    /**
     * Build the descriptor list for one Agent run. Caller filters
     * further based on which tools the LangChain tool-loop wrapper
     * actually knows how to invoke.
     *
     * The `editsThisRunByFile` arg tracks which Agent files have
     * already been edited inside this same run — used by the
     * once-per-file-per-run cap on `editAgentFile` (security §7
     * mitigation against tool-loop hammering).
     */
    resolveAllowedTools(
        agent: Agent,
        runContext: { runId: string; editsThisRunByFile: Set<string> } = {
            runId: 'no-run',
            editsThisRunByFile: new Set(),
        },
    ): AgentToolDescriptor[] {
        const tools: AgentToolDescriptor[] = [];

        // getSkillBody — auto-registered when at least one skill is bound.
        // Phase 10.3 ships the factory; the registration predicate is
        // applied by AgentRunService when assembling the prompt. Here
        // we always expose the descriptor when both repos are wired —
        // the model only sees it when bindings exist (AgentRunService
        // filters), and the descriptor itself errors on unbound slugs.
        if (this.skills && this.bindings) {
            tools.push(
                createGetSkillBodyTool(this.skills, this.bindings, {
                    userId: agent.userId,
                    agentId: agent.id,
                    workId: agent.workId ?? undefined,
                    missionId: agent.missionId ?? undefined,
                    ideaId: agent.ideaId ?? undefined,
                }) as AgentToolDescriptor,
            );
        }

        // editAgentFile — gated by permissions.canEditAgentFiles.
        // 1 edit per file per run (frequency cap from security spec §7).
        if (agent.permissions?.canEditAgentFiles && this.files) {
            tools.push(this.buildEditAgentFileTool(agent, runContext));
        }

        // createSubAgent — gated by permissions.canCreateAgents.
        if (agent.permissions?.canCreateAgents) {
            tools.push(this.buildCreateSubAgentTool(agent));
        }

        // Phase 16.6 — commitToRepo. Gated by permissions.canCommitToRepo
        // + the AGENT_GIT_FACADE token being bound by the platform.
        // Mission/Idea/Tenant-scoped Agents can't commit because there's
        // no implicit Work; the tool still exposes the descriptor but
        // rejects at invoke time with a clear "scope-not-Work" error so
        // the model receives an actionable response instead of a missing
        // tool. Work-scoped Agents pass through to the adapter.
        if (agent.permissions?.canCommitToRepo && this.git) {
            tools.push(this.buildCommitToRepoTool(agent));
        }

        // Phase 16.7 — openPullRequest. Permission chain enforced at the
        // service layer (Phase 3.2): canOpenPullRequests ⇒ canCommitToRepo
        // so the model can never produce a PR without an associated
        // commit permission grant. We still gate the descriptor on the
        // granular flag.
        if (agent.permissions?.canOpenPullRequests && this.git) {
            tools.push(this.buildOpenPullRequestTool(agent));
        }

        // Phase 16.10 — plugin pass-through tools (searchWeb /
        // screenshot / extractContent). Single permission gate
        // (canCallExternalTools) per architecture spec §6 — these
        // share the same "outbound network call" risk class. Gated on
        // token presence so when the platform hasn't wired the adapter
        // the model never sees the tools.
        if (agent.permissions?.canCallExternalTools && this.pluginTools) {
            tools.push(this.buildSearchWebTool(agent));
            tools.push(this.buildScreenshotTool(agent));
            tools.push(this.buildExtractContentTool(agent));
        }

        // getActivity + getKbDocument — placeholders that document the
        // surface; real implementations land alongside the activity
        // log + KB document read surfaces wiring into this package.
        tools.push(this.buildGetActivityTool(agent));
        tools.push(this.buildGetKbDocumentTool(agent));

        return tools;
    }

    // ── tool builders ─────────────────────────────────────────────

    private buildEditAgentFileTool(
        agent: Agent,
        runContext: { runId: string; editsThisRunByFile: Set<string> },
    ): AgentToolDescriptor<
        { name: string; body: string; expectedHash?: string },
        { newHash: string }
    > {
        return {
            name: 'editAgentFile',
            description:
                "Edit one of YOUR OWN definition files (SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml). Body is secret-scanned, 64 KB cap, once per file per run. Pass expectedHash for optimistic concurrency. NEVER edit another Agent's files.",
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description:
                            'One of SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml',
                    },
                    body: { type: 'string', description: 'Full new body of the file. ≤ 64 KB.' },
                    expectedHash: {
                        type: 'string',
                        description:
                            'Optional content hash of the LAST version you read. Pass it for optimistic concurrency.',
                    },
                },
                required: ['name', 'body'],
            },
            invoke: async (args) => {
                if (!args?.name || !args?.body) {
                    return { error: 'name and body are required' };
                }
                const key = `${agent.id}:${args.name}`;
                if (runContext.editsThisRunByFile.has(key)) {
                    return {
                        error: `editAgentFile: file "${args.name}" was already edited once in this run (cap: 1 edit per file per run).`,
                    };
                }
                try {
                    const result = await this.files!.write({
                        userId: agent.userId,
                        agentId: agent.id,
                        name: args.name as any,
                        body: args.body,
                        expectedHash: args.expectedHash,
                    });
                    runContext.editsThisRunByFile.add(key);
                    return result;
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildCreateSubAgentTool(
        actor: Agent,
    ): AgentToolDescriptor<
        { name: string; title?: string; capabilities?: string },
        { id: string; slug: string }
    > {
        return {
            name: 'createSubAgent',
            description:
                'Spawn a new Agent inside YOUR scope. The sub-Agent is created in DRAFT status with ALL permissions FALSE — the user must activate it + grant capabilities manually. Returns the new Agent id + slug.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Human-readable name. The slug is derived from it.',
                    },
                    title: {
                        type: 'string',
                        description: 'Optional role line (e.g. "Frontend reviewer").',
                    },
                    capabilities: {
                        type: 'string',
                        description: 'Optional free-form capability summary.',
                    },
                },
                required: ['name'],
            },
            invoke: async (args) => {
                if (!args?.name) return { error: 'name is required' };
                try {
                    // Review-fix I6: route through AgentsService.create()
                    // when available so the model gets a structured
                    // ConflictException instead of a raw DB unique-
                    // constraint violation. Falls back to repo.create
                    // only when the service isn't bound (unit-test mode).
                    if (this.agentsService) {
                        const dto = await this.agentsService.create(actor.userId, {
                            scope: actor.scope,
                            missionId:
                                actor.scope === AgentScope.MISSION
                                    ? (actor.missionId ?? undefined)
                                    : null,
                            ideaId:
                                actor.scope === AgentScope.IDEA
                                    ? (actor.ideaId ?? undefined)
                                    : null,
                            workId:
                                actor.scope === AgentScope.WORK
                                    ? (actor.workId ?? undefined)
                                    : null,
                            name: args.name,
                            title: args.title ?? null,
                            capabilities: args.capabilities ?? null,
                            aiProviderId: actor.aiProviderId ?? null,
                            modelId: actor.modelId ?? null,
                            maxSkillContextTokens: 4000,
                            // Spec security §6 — sub-Agent always DRAFT,
                            // permissions all-false (use the shared default
                            // constant so future flag additions stay in sync).
                            permissions: { ...AGENT_PERMISSIONS_DEFAULT },
                        });
                        return { id: dto.id, slug: dto.slug };
                    }
                    // Fallback repository path (unit-test mode only).
                    // Sub-Agent inherits actor's scope verbatim — Mission-
                    // scoped Agent creates Mission-scoped sub-Agent on the
                    // same Mission. Permissions stay all-false per spec.
                    const created = await this.agents.create({
                        userId: actor.userId,
                        scope: actor.scope,
                        missionId: actor.scope === AgentScope.MISSION ? actor.missionId : null,
                        ideaId: actor.scope === AgentScope.IDEA ? actor.ideaId : null,
                        workId: actor.scope === AgentScope.WORK ? actor.workId : null,
                        name: args.name,
                        slug: slugify(args.name),
                        title: args.title ?? null,
                        capabilities: args.capabilities ?? null,
                        aiProviderId: actor.aiProviderId ?? null,
                        modelId: actor.modelId ?? null,
                        maxSkillContextTokens: 4000,
                        // Second-pass fix: drop the redundant `as any` casts —
                        // the enum values are well-typed.
                        status: AgentStatus.DRAFT,
                        permissions: { ...AGENT_PERMISSIONS_DEFAULT } as AgentPermissions,
                        targets: null,
                        heartbeatCadence: null,
                        idleBehavior: actor.idleBehavior,
                        pauseAfterFailures: 3,
                        errorCount: 0,
                        avatarMode: AgentAvatarMode.INITIALS,
                        avatarIcon: null,
                        avatarImageUploadId: null,
                    });
                    return { id: created.id, slug: created.slug };
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildCommitToRepoTool(
        agent: Agent,
    ): AgentToolDescriptor<
        { message: string; files?: { path: string; body: string }[]; branch?: string },
        AgentCommitToRepoResult
    > {
        return {
            name: 'commitToRepo',
            description:
                "Commit a batch of file edits to the active Work's git repo. Requires Work scope on this Agent + canCommitToRepo permission. Pass a clear commit message and optional file edits to stage. Returns the resulting commit SHA, target branch, and number of files changed. The adapter resolves the provider + repo + committer identity from the Work's git settings.",
            parameters: {
                type: 'object',
                properties: {
                    message: {
                        type: 'string',
                        description:
                            'Commit message. Should be agent-authored and reference what changed.',
                    },
                    files: {
                        // Review-fix C5: array, not string. LLMs honor schema types.
                        type: 'array',
                        items: { type: 'object' },
                        description:
                            'Optional array of {path, body} objects to stage before committing. When omitted, commits whatever previous tool calls already staged.',
                    },
                    branch: {
                        type: 'string',
                        description:
                            "Branch name to commit against. Defaults to the Work's main branch.",
                    },
                },
                required: ['message'],
            },
            invoke: async (args) => {
                if (!args?.message || args.message.trim().length === 0) {
                    return { error: 'message is required.' };
                }
                if (agent.scope !== AgentScope.WORK || !agent.workId) {
                    return {
                        error: 'commitToRepo: this Agent is not Work-scoped — no implicit repo target. Re-create the Agent with scope=work on a Work that has git settings.',
                    };
                }
                if (!this.git) {
                    return {
                        error: 'commitToRepo: git facade is not bound in this runtime. Ask the operator to wire AGENT_GIT_FACADE.',
                    };
                }
                try {
                    return await this.git.commitToRepo({
                        userId: agent.userId,
                        agentId: agent.id,
                        workId: agent.workId,
                        message: args.message,
                        files: args.files,
                        branch: args.branch,
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildOpenPullRequestTool(
        agent: Agent,
    ): AgentToolDescriptor<
        { title: string; body: string; head: string; base?: string; draft?: boolean },
        AgentOpenPullRequestResult
    > {
        return {
            name: 'openPullRequest',
            description:
                "Open a Pull Request on the active Work's git repo. Requires Work scope on this Agent + canOpenPullRequests permission (which transitively requires canCommitToRepo). Provide title, body, head branch (the branch you committed to), and optional base + draft flag. Returns the PR number, URL, and state.",
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description:
                            'PR title — should match conventional-commit style when the Work uses it.',
                    },
                    body: {
                        type: 'string',
                        description: 'PR body — markdown is fine. Summarize what changed and why.',
                    },
                    head: {
                        type: 'string',
                        description: 'Branch name containing the commits.',
                    },
                    base: {
                        type: 'string',
                        description: "Optional base branch. Defaults to the Work's default branch.",
                    },
                    draft: {
                        // Review-fix C5: boolean, not string.
                        type: 'boolean',
                        description: 'Optional flag — open as a draft PR. Default false.',
                    },
                },
                required: ['title', 'body', 'head'],
            },
            invoke: async (args) => {
                if (!args?.title || !args?.body || !args?.head) {
                    return { error: 'title, body, and head are required.' };
                }
                if (agent.scope !== AgentScope.WORK || !agent.workId) {
                    return {
                        error: 'openPullRequest: this Agent is not Work-scoped — no implicit repo target.',
                    };
                }
                if (!this.git) {
                    return {
                        error: 'openPullRequest: git facade is not bound in this runtime. Ask the operator to wire AGENT_GIT_FACADE.',
                    };
                }
                try {
                    return await this.git.openPullRequest({
                        userId: agent.userId,
                        agentId: agent.id,
                        workId: agent.workId,
                        title: args.title,
                        body: args.body,
                        head: args.head,
                        base: args.base,
                        draft: args.draft,
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildSearchWebTool(
        agent: Agent,
    ): AgentToolDescriptor<
        {
            query: string;
            maxResults?: number;
            includeDomains?: string[];
            excludeDomains?: string[];
        },
        AgentSearchWebResult
    > {
        return {
            name: 'searchWeb',
            description:
                'Web search via the active search plugin (Tavily / Brave / etc.). Returns ranked results with title, URL, and optional snippet. Requires canCallExternalTools. Use sparingly — every call hits the per-Work budget.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query.' },
                    maxResults: {
                        // Review-fix C5: integer, not string.
                        type: 'integer',
                        description:
                            "Optional cap on result count. Defaults to the plugin's default.",
                    },
                    includeDomains: {
                        // Review-fix C5: array of strings, not a single string.
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of domains to bias toward.',
                    },
                    excludeDomains: {
                        // Review-fix C5: array of strings, not a single string.
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of domains to filter out.',
                    },
                },
                required: ['query'],
            },
            invoke: async (args) => {
                if (!args?.query || args.query.trim().length === 0) {
                    return { error: 'query is required.' };
                }
                try {
                    return await this.pluginTools!.searchWeb({
                        userId: agent.userId,
                        agentId: agent.id,
                        workId: agent.workId ?? undefined,
                        query: args.query,
                        maxResults: args.maxResults,
                        includeDomains: args.includeDomains,
                        excludeDomains: args.excludeDomains,
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildScreenshotTool(
        agent: Agent,
    ): AgentToolDescriptor<
        { url: string; viewportWidth?: number; viewportHeight?: number; fullPage?: boolean },
        AgentScreenshotResult
    > {
        return {
            name: 'screenshot',
            description:
                'Capture a screenshot of a URL via the active screenshot plugin. Returns the imageUrl (and cacheUrl when available). Requires canCallExternalTools. Used when visual layout context matters and a text extraction would miss it.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to screenshot.' },
                    // Review-fix C5: numbers + boolean, not strings.
                    viewportWidth: {
                        type: 'integer',
                        description: 'Optional viewport width in px.',
                    },
                    viewportHeight: {
                        type: 'integer',
                        description: 'Optional viewport height in px.',
                    },
                    fullPage: {
                        type: 'boolean',
                        description: 'Optional full-page flag. Default false.',
                    },
                },
                required: ['url'],
            },
            invoke: async (args) => {
                if (!args?.url || args.url.trim().length === 0) {
                    return { error: 'url is required.' };
                }
                try {
                    return await this.pluginTools!.screenshot({
                        userId: agent.userId,
                        agentId: agent.id,
                        workId: agent.workId ?? undefined,
                        url: args.url,
                        viewportWidth: args.viewportWidth,
                        viewportHeight: args.viewportHeight,
                        fullPage: args.fullPage,
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildExtractContentTool(
        agent: Agent,
    ): AgentToolDescriptor<{ url: string; maxChars?: number }, AgentExtractContentResult> {
        return {
            name: 'extractContent',
            description:
                "Fetch and clean a URL's primary text content via the active content-extractor plugin (Firecrawl / Tavily extract / Readability fallback). Returns the cleaned body + content length. Requires canCallExternalTools. Prefer over raw fetch — the extractor strips nav/ads/footers.",
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to extract.' },
                    maxChars: {
                        // Review-fix C5: integer, not string.
                        type: 'integer',
                        description:
                            'Optional cap on returned characters. Defaults to 50000 (the adapter clamps).',
                    },
                },
                required: ['url'],
            },
            invoke: async (args) => {
                if (!args?.url || args.url.trim().length === 0) {
                    return { error: 'url is required.' };
                }
                try {
                    return await this.pluginTools!.extractContent({
                        userId: agent.userId,
                        agentId: agent.id,
                        workId: agent.workId ?? undefined,
                        url: args.url,
                        maxChars: args.maxChars,
                    });
                } catch (err) {
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        };
    }

    private buildGetActivityTool(
        agent: Agent,
    ): AgentToolDescriptor<{ since?: string; limit?: number }, { entries: unknown[] }> {
        return {
            name: 'getActivity',
            description:
                "Read recent activity-log rows for YOUR scope (last 30 days max). Useful when context wasn't injected by default and you need to look up what happened. Returns a compact JSON array.",
            parameters: {
                type: 'object',
                properties: {
                    since: {
                        type: 'string',
                        description: 'ISO timestamp lower bound. Defaults to 24h ago.',
                    },
                    // Review-fix C5: integer, not string.
                    limit: {
                        type: 'integer',
                        description: 'Max rows. Defaults to 50, capped at 200.',
                    },
                },
                required: [],
            },
            invoke: async () => {
                // Phase 16 v1 — placeholder. Wires once ActivityLogService
                // exposes a scope-filterable findRecent() method that this
                // package can call without a circular import.
                void agent;
                return { entries: [] };
            },
        };
    }

    private buildGetKbDocumentTool(
        agent: Agent,
    ): AgentToolDescriptor<{ slug: string }, { slug: string; body: string }> {
        return {
            name: 'getKbDocument',
            description:
                'Fetch the full body of a KB document by slug from a Mission/Work/Idea you have access to. Errors when the slug is not reachable from this Agent.',
            parameters: {
                type: 'object',
                properties: {
                    slug: {
                        type: 'string',
                        description: 'KB document slug (lowercase-with-hyphens).',
                    },
                },
                required: ['slug'],
            },
            invoke: async (args) => {
                void agent;
                if (!args?.slug) return { error: 'slug is required' };
                // Phase 16 v1 — placeholder. Wires once KB read surface
                // is reachable from this package (mirror approach for the
                // scope filter is the same as getActivity).
                return {
                    error: `getKbDocument: not yet available in v1 — slug ${args.slug} unreachable.`,
                };
            },
        };
    }
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}
