---
id: agent-injection-tokens
title: Agent/Task Injection Tokens
sidebar_label: Agent/Task Injection Tokens
sidebar_position: 22
---

# Agent/Task Injection Tokens

The Agents/Skills/Tasks feature set (PR #1017) introduces a family of
Nest injection tokens that platform operators can bind to custom
adapters. Each token follows the same posture: the agent package
defines a small contract interface; downstream services consume the
contract via `@Optional() @Inject(TOKEN)`; the API-side module
(`apps/api/src/agents/agents.module.ts` or `apps/api/src/tasks/tasks.module.ts`)
binds the token to a thin adapter over the real platform service.

This page is the single reference for what each token does, what's
bound by default, and the binding pattern.

## Why injection tokens

Three concerns drove this layout:

1. **Circular-dep avoidance.** Many of these adapters bridge the
   agent package's `agents/` module with services in `tasks-domain/`
   or `facades/`. Importing the concrete services directly would
   create a graph cycle. Tokens break the cycle: the agent module
   only knows the contract; the platform module owns the binding.
2. **Operator opt-in for risky tools.** `commitToRepo` /
   `openPullRequest` are deliberately unbound by default — operators
   bind them only when the git provider configuration is stable.
   Leaving the token unbound keeps the model from seeing tools that
   would fail mysteriously at invoke time.
3. **Best-effort side effects.** Post-processor failures (a flaky
   chat-back insert, a transition gate rejection) should not unwind
   the upstream LLM work. The `@Optional()` injection + try/catch
   wrapper at the consumer site enforces this contract.

## Inventory

| Token | Contract | Consumer | Default binding |
|-------|----------|----------|-----------------|
| `AGENT_TASK_EXECUTE_DISPATCHER` | `AgentTaskExecuteDispatcher` | `TaskTransitionService` | `agentTaskExecuteTriggerAdapter` (Trigger.dev) |
| `AGENT_CHAT_REPLY_DISPATCHER` | `AgentChatReplyDispatcher` | `TaskChatService.post` | `agentChatReplyTriggerAdapter` (Trigger.dev) |
| `AGENT_RUN_CHAT_BACK_POSTER` | `AgentRunChatBackPoster` | `AgentRunService.finalize` | `TaskChatService.post(authorType='agent')` |
| `AGENT_RUN_TASK_FINISHER` | `AgentRunTaskFinisher` | `AgentRunService.finalize` | `TasksService.transition` |
| `AGENT_GIT_FACADE` | `AgentGitFacade` | `AgentToolService` | **UNBOUND** in v1 |
| `AGENT_PLUGIN_TOOLS_FACADE` | `AgentPluginToolsFacade` | `AgentToolService` | `SearchFacadeService` + `ScreenshotFacadeService` + `ContentExtractorFacadeService` |

All token strings are exported from `@ever-works/agent/agents` and
`@ever-works/agent/tasks-domain` respectively. Contract interfaces
ship alongside.

## Token-by-token reference

### `AGENT_TASK_EXECUTE_DISPATCHER`

**Contract**

```typescript
interface AgentTaskExecuteDispatcher {
    enqueue(payload: {
        agentId: string;
        userId: string;
        taskId: string;
        dedupKey: string;
    }): Promise<{ runId: string }>;
}
```

**Consumer**: `TaskTransitionService.transition()`, on every
`→ in_progress` transition, for each Agent assignee on the Task.

**Default binding**: `agentTaskExecuteTriggerAdapter` from
`packages/tasks/src/dispatchers/agent-task-dispatchers.ts` —
forwards to a Trigger.dev `agent-task-execute` job
(`maxDuration=3600`). `dedupKey = '${taskId}:${agentId}:${recurrenceOccurredCount + 1}'`.

**When to override**: testing (synchronous in-process dispatcher
for e2e specs); replacing Trigger.dev with another job runner.

### `AGENT_CHAT_REPLY_DISPATCHER`

**Contract**

```typescript
interface AgentChatReplyDispatcher {
    enqueue(payload: {
        agentId: string;
        userId: string;
        taskId: string;
        triggeringMessageId: string;
        dedupKey: string;
    }): Promise<{ runId: string }>;
}
```

**Consumer**: `TaskChatService.post()`, for every resolved
`@agent` mention.

**Default binding**: `agentChatReplyTriggerAdapter` — Trigger.dev
`agent-chat-reply` job (`maxDuration=300`). T6 chat-dedup posture:
an in-flight run for the same (taskId, agentId) is re-used rather
than spawned.

**When to override**: same as above — testing and alternate job runners.

### `AGENT_RUN_CHAT_BACK_POSTER`

**Contract**

```typescript
interface AgentRunChatBackPoster {
    postReply(input: {
        userId: string;
        taskId: string;
        agentId: string;
        body: string;
    }): Promise<{ messageId: string }>;
}
```

**Consumer**: `AgentRunService.finalize(context, outcome)` —
called for `chat` kind outcomes when `outcome.replyBody` is set.

**Default binding** (in `apps/api/src/agents/agents.module.ts`):

```typescript
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
}
```

The wrapped `TaskChatService.post()` still runs the mention parser
+ secret-scan + size cap, so an agent-authored reply gets the same
treatment as a user-authored one.

**When to override**: routing chat-back posts through an alternate
chat surface (Slack, email digest, etc.); short-circuiting the post
to a moderation queue.

### `AGENT_RUN_TASK_FINISHER`

**Contract**

```typescript
interface AgentRunTaskFinisher {
    finishTask(input: {
        userId: string;
        taskId: string;
        to: 'done' | 'in_review' | 'blocked' | 'cancelled';
        force?: boolean;
    }): Promise<{ status: string }>;
}
```

**Consumer**: `AgentRunService.finalize()` — called for `task` kind
outcomes when `outcome.taskFinishStatus` is set.

**Default binding**: `useFactory(TasksService)` forwarding to
`tasks.transition(userId, taskId, to, { force })`. The transition
runs through `TaskTransitionService`'s state-machine, so
blocker/approver gates still apply (`force=true` overrides
approver only, not blocker — security spec §6).

**When to override**: routing the status flip through an
approval-required workflow; auditing every agent-driven transition
in a separate event stream.

### `AGENT_GIT_FACADE`

**Contract**

```typescript
interface AgentGitFacade {
    commitToRepo(input: {
        userId: string;
        agentId: string;
        workId: string;
        message: string;
        files?: { path: string; body: string }[];
        branch?: string;
    }): Promise<{ sha: string | null; branch: string; filesChanged: number }>;

    openPullRequest(input: {
        userId: string;
        agentId: string;
        workId: string;
        title: string;
        body: string;
        head: string;
        base?: string;
        draft?: boolean;
    }): Promise<{ number: number; url: string; state: 'open' | 'closed' | 'merged' | 'draft' }>;
}
```

**Consumer**: `AgentToolService.resolveAllowedTools()` — when
bound, the `commitToRepo` and `openPullRequest` tool descriptors
appear in the Agent's per-run tool list (gated additionally on the
matching `permissions.canCommitToRepo` / `canOpenPullRequests`
flags).

**Default binding**: **UNBOUND**. The token is intentionally not
wired in v1 of `apps/api/src/agents/agents.module.ts`. Leaving it
unbound means the descriptors are simply absent from the model's
tool list — better than the model seeing a tool that mysteriously
fails because the platform git provider isn't configured.

**When to override**: bind once the operator's git provider setup
is stable. Suggested adapter shape:

```typescript
{
    provide: AGENT_GIT_FACADE,
    inject: [GitFacadeService, WorkRepository],
    useFactory: (git: GitFacadeService, works: WorkRepository): AgentGitFacade => ({
        async commitToRepo({ userId, agentId, workId, message, files, branch }) {
            const work = await works.findByIdAndUser(workId, userId);
            if (!work) throw new Error('Work not reachable.');
            // Resolve provider + repo dir + auth from work settings,
            // stage `files`, then forward into git.commit() / .push().
            // See packages/agent/src/facades/git.facade.ts for the
            // underlying methods.
            //
            // ... operator-specific resolution logic ...
            return { sha, branch: resolvedBranch, filesChanged };
        },
        async openPullRequest({ ... }) { ... },
    }),
}
```

### `AGENT_PLUGIN_TOOLS_FACADE`

**Contract**

```typescript
interface AgentPluginToolsFacade {
    searchWeb(input: AgentSearchWebInput): Promise<AgentSearchWebResult>;
    screenshot(input: AgentScreenshotInput): Promise<AgentScreenshotResult>;
    extractContent(input: AgentExtractContentInput): Promise<AgentExtractContentResult>;
}
```

(See `packages/agent/src/agents/agent-plugin-tools-facade.ts` for
the full payload shapes — each carries `userId / agentId / workId? /
taskId?` for Phase 15.6 attribution.)

**Consumer**: `AgentToolService` — when bound, the `searchWeb` /
`screenshot` / `extractContent` tool descriptors appear in the
Agent's tool list (gated on `permissions.canCallExternalTools` AND
token presence).

**Default binding**:
`useFactory(SearchFacadeService, ScreenshotFacadeService, ContentExtractorFacadeService)`.
Each forwarded call threads `agentId` + `taskId` onto
`FacadeOptions` so the resulting `PluginUsageEvent` rows carry full
attribution (per-Agent + per-Task spend rollups work without
additional plumbing).

`extractContent` clamps `maxChars` to a 50 KB default / 200 KB hard
cap so a long-page extract can't bloat the model context window.

**When to override**: stubbing out external network calls in test
environments; routing through a moderation/cache proxy.

## Binding posture

All bindings live in the api-side module (`apps/api/src/{agents,tasks}/...module.ts`),
not the agent-side. The agent-side module
(`packages/agent/src/agents/agents.module.ts`) declares no
defaults for these tokens — that's the entire point of the
indirection. This means:

- Unit tests for agent services can pass plain jest mocks for the
  token slot (or omit it entirely; `@Optional()` honors the absence).
- The platform module is the single source of truth for what
  "production wired" means.
- Operators can swap any token without touching the agent package.

### `@Global()` is REQUIRED on api-side modules that bind these tokens

The api-side `TasksModule` and `AgentsModule` (the ones that bind the
6 tokens via `useFactory`) are both declared `@Global()`. **This is
load-bearing — do not remove the decorator.**

The reason: the consumers (`TaskTransitionService`, `TaskChatService`,
`AgentRunService`, `AgentToolService`) live in the imported
agent-package modules (`TasksDomainModule`, agent-side `AgentsModule`).
NestJS's module isolation rule is *providers from a parent module are
NOT visible to services in an imported child module's DI scope*.
Without `@Global()` the `@Optional() @Inject(TOKEN)` calls silently
resolve to `undefined` in production — every unit test still passes
(each binds tokens locally in its `TestingModule`), but the entire
Phase-15 dispatch + post-processor + plugin-tools surfaces no-op at
runtime with no error message.

When you write your own override binding, put it in a module that
already imports (or IS) the global api-side module — OR mark your
custom module `@Global()` so the token reaches consumers regardless of
import direction.

## Test posture

Each consumer ships with unit tests that verify the consumer's
behavior **with the token unbound** (descriptors absent / side
effects skipped) and **with the token bound to a jest mock** (happy
invoke + payload shape). See:

- `packages/agent/src/agents/__tests__/agent-run-finalize.spec.ts` —
  chat-back poster + task finisher
- `packages/agent/src/agents/__tests__/agent-tool-git.spec.ts` —
  commitToRepo + openPullRequest descriptors
- `packages/agent/src/agents/__tests__/agent-tool-plugins.spec.ts` —
  searchWeb / screenshot / extractContent descriptors

## Migration from manually-wired services

If you wired one of these surfaces by hand pre-PR-1017 (e.g. an
in-house `CommitToRepoService` that the Agent runtime called
directly), the recommended migration is to keep your existing
service and bind it via a thin adapter at the API layer:

```typescript
{
    provide: AGENT_GIT_FACADE,
    inject: [MyExistingCommitToRepoService],
    useFactory: (svc: MyExistingCommitToRepoService): AgentGitFacade => ({
        commitToRepo: (input) => svc.legacyCommit(input),
        openPullRequest: (input) => svc.legacyPr(input),
    }),
}
```

This keeps the agent package free of any direct dependency on your
service while letting the rest of the Agent tool surface activate
end-to-end. No agent-side code changes required.
