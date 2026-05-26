# Architecture: Agent prompt assembly

**Status**: `Draft`
**Last updated**: 2026-05-25
**Audience**: Engineers wiring `AgentRunService.execute()` and the assistants reasoning about how a user-defined Agent's identity, memory, and constraints get into an AI call.

---

## 1. Purpose

When a user-defined Agent runs (heartbeat tick, task execution, or chat reply), the platform must assemble a coherent system message + user-message stack that:

1. Carries the Agent's **identity** (`SOUL.md`) and **role** (`AGENTS.md`).
2. Tells the Agent what to do **right now** — heartbeat directive (`HEARTBEAT.md`), task description, or chat thread context.
3. Constrains it via **permissions** (`TOOLS.md` and the `agents.permissions` JSON column).
4. Augments it with **skills** (resolved per the hierarchy in [`agents-skills-tasks.md` §8](./agents-skills-tasks.md)).
5. Provides **memory** (recent runs, recent activity, scope state) without blowing the token budget.
6. Honors the Work / Mission / Idea **WorkAdvancedPrompts** (existing per-scope prompt overrides) when the run is scoped to one.

The platform's existing `AiFacadeService` ([`packages/agent/src/facades/ai.facade.ts`](../../packages/agent/src/facades/ai.facade.ts)) does **not** assemble system messages today — pipeline plugins do that internally. The new `AgentRunService.execute()` will assemble the message itself and pass the final composed payload to `AiFacadeService.createChatCompletion()` / `createStreamingChatCompletion()` / `askJson()` via the existing `messages` parameter.

This doc specifies the canonical assembly order so different Agent triggers (heartbeat / task / chat) produce comparable prompts.

## 2. Assembly order — system message

The system message is a concatenation of named segments. Lower index = earlier in the message = higher priority for the model's attention.

| # | Segment                       | Source                                                                                                   | Budget (tokens) | Required? |
| - | ----------------------------- | -------------------------------------------------------------------------------------------------------- | --------------- | --------- |
| 1 | **Identity (`SOUL.md`)**      | Agent's `SOUL.md`                                                                                        | full            | ✓         |
| 2 | **Role (`AGENTS.md`)**        | Agent's `AGENTS.md`                                                                                      | full            | ✓         |
| 3 | **Capabilities**              | `agents.capabilities` TEXT column                                                                        | full            | optional  |
| 4 | **Operating loop**            | Agent's `HEARTBEAT.md` (heartbeat run only) OR a per-trigger preamble (task / chat)                       | full            | ✓         |
| 5 | **Tools the Agent may call**  | Agent's `TOOLS.md` filtered by `permissions.canCallExternalTools` etc.                                    | up to 1500      | ✓         |
| 6 | **Active Skills**             | Skills resolved by `SkillBindingRepository.resolveActive` ([Skills spec §3.3](../features/skills/spec.md)). Progressive disclosure. | `maxSkillContextTokens` (default 4000) | optional  |
| 7 | **Scope WorkAdvancedPrompts** | For Work-scoped Agents, the relevant WorkAdvancedPrompts column ([`work-advanced-prompts.entity.ts`](../../packages/agent/src/entities/work-advanced-prompts.entity.ts)) | full            | optional  |
| 8 | **Scope context**             | Mission description / Idea description / Work `initial_prompt` — depends on scope                         | up to 800       | ✓         |
| 9 | **Memory: recent activity**   | Last N=20 `activity_log` rows for this Agent's scope (filtered to events the Agent should "know about")   | up to 1200      | optional  |
| 10 | **Memory: last N runs**       | Compact JSON of the Agent's last 5 `agent_runs` summaries                                                | up to 800       | optional  |
| 11 | **Output contract**           | Strict JSON-schema reminder when caller used `askJson()`; otherwise free-form                            | 150             | depends   |

Total budget target: **≤ 12 000 input tokens** in the system message. If a segment exceeds its budget, it is **truncated tail-first** (newest preserved, oldest cut). Truncation events emit an `AgentRunLog` row at `level=WARN, step='prompt-assembly'`.

Order rationale:
- Identity + Role first — the model anchors on "who am I and what do I do" before "how do I do it."
- Tools before Skills — Skills may reference tools; the tool list must be parsed first.
- Skills before scope context — Skills should be domain-agnostic enough to apply across scopes.
- Memory after instructions — memory tunes; instructions shape.
- Output contract last — closest to the model's response, hardest to forget.

### 2.1 Per-trigger preamble (segment 4)

For non-heartbeat triggers, segment 4 is replaced by a static preamble instead of `HEARTBEAT.md`:

**Task execution preamble:**

```
You are working on a specific Task assigned to you. The Task body
follows. Your output should advance the Task — make progress, ask a
clarifying question in the Task chat, transition the Task status,
or escalate by creating a sub-task. Do NOT take actions outside the
scope of this Task.
```

**Chat reply preamble:**

```
You were mentioned in a Task chat thread. Read the recent messages,
then post a single reply. Do NOT transition the Task status from a
chat reply — use the transition tool only when explicitly asked.
Keep the reply focused on the chat question.
```

## 3. User message

Composed of:

| # | Content                                                                                          |
| - | ------------------------------------------------------------------------------------------------ |
| 1 | The **immediate input** — for heartbeat, the literal string `"What's the next action you should take? Choose ONE."`; for task, the Task description; for chat, the new chat message body. |
| 2 | The **conversation context** — for task, the most recent 20 `task_chat_messages` of that task (newest last); for chat, the same. For heartbeat, omitted. |
| 3 | **Attachments / mentions / KB references** rendered inline as fenced blocks the model can read. KB references injected as their `instructionsMd` body. |

## 4. Memory model

### 4.1 Short-term (within a run)

The model sees segments 9-10 (recent activity + recent runs) as part of every run. This is the platform's "short-term memory" — last few hours / runs.

If the run does multiple tool-loop iterations (read a KB doc, then write a file, then post a chat), short-term memory accumulates inside the run as **standard tool-loop messages**. No additional storage; this lives in the in-flight LangChain conversation.

### 4.2 Long-term (across runs)

The Agent's **SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md** are the long-term memory. They are durable, intentional, and editable.

Crucially: long-term memory is **not** automatically updated. The Agent has to actively decide "this is important enough to remember forever" and use the `editAgentFile` tool to append a paragraph. This keeps the model from polluting its identity files with conversational noise. See [Agent self-editing rules](#62-self-editing-rules) below.

For passive history (last 30 days of activity), the model reads `activity_log` on demand via a `getActivity({since, limit})` tool. Not injected by default — costs tokens.

### 4.3 Cross-Agent memory

Agents cannot read each other's MD files. Cross-Agent knowledge flows through:
- **Tasks** — assigning, commenting, mentioning.
- **Mission/Work KB** — any Agent in scope can read KB documents.
- **Activity log** — `getActivity()` includes other Agents' run summaries (but not their prompts).

This is intentional separation of identity (private) from work product (shared).

## 5. Token budgeting

The dispatcher's pre-flight check (`BudgetGuardService.checkBudget`) estimates cost from an upper-bound token count: assembled system message + user message + 1500 reserved for the model's response. If the estimate would exceed remaining budget AND `allowOverage = false`, the run is short-circuited to `failed` with `errorMessage='Budget exceeded'`.

Actual usage is captured post-call by the existing `PluginUsageEvent` write inside `AiFacadeService` ([research report Topic 1](./agents-skills-tasks.md)), with the new `agentId` and optional `taskId` columns set.

## 6. Conflict resolution

### 6.1 Between Agent's MD files

If `SOUL.md` says "be terse" and `AGENTS.md` says "be thorough" — the model is left to reconcile. We do not pre-resolve. The model's reasoning surfaces in its response and the user can iterate the files. The platform's only guarantee is **order** — SOUL is first, AGENTS is second, so identity has precedence over role description by attention-position bias.

### 6.2 Between MD files and user task

User-task input wins. The Agent's `HEARTBEAT.md` may say "don't write code"; a Task with `description: "write the migration"` overrides for that Task. Modeled the same as a human employee: written role + ad-hoc assignment.

### 6.3 Between Agent's permissions and Skill's `allowed-tools`

Permissions ALWAYS win. If `permissions.canCommitToRepo = false`, a skill whose `allowed-tools` includes `git` is rendered (the model sees it) but the `commitToRepo` tool returns a structured error when invoked. The skill body becomes context; not a back-door to the tool.

### 6.4 Between WorkAdvancedPrompts and Agent prompts

WorkAdvancedPrompts is the **per-Work** override of the Work Generator's prompts. For Work-scoped Agents that are **executing a Generator-relevant stage** (e.g. an Agent specialized in "categorization"), the relevant WorkAdvancedPrompts column is injected as segment 7.

For Agents NOT executing a generator stage (e.g. the CEO doing strategy), segment 7 is skipped.

The decision is made by `AgentRunService.execute()` from the calling context: if the run was triggered by a Task whose body references a generator stage, fetch that column; otherwise skip.

## 7. Self-editing rules

When the Agent calls `editAgentFile({name, body})`:

1. **Scope check** — `name ∈ {'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'}` for the agent's own subtree only.
2. **Permission check** — `permissions.canEditAgentFiles = true`.
3. **Secret scan** — body must not match the secret-scan regex (`sk-`, `xoxb-`, `AKIA…`, `ghp_…`, `glpat-…`).
4. **Size cap** — body ≤ 64 KB per file.
5. **Frequency cap** — at most 1 edit per file per run (prevents tool-loop hammering).
6. **Hash check** — if `etag` is supplied in the tool call, must match `agents.contentHash` (optimistic concurrency).
7. **Commit / inline write** — for Mission/Work-scoped Agents, `GitFacadeService.commit()` with message `chore(agent/<slug>): self-edit <file> via run <runId>`; for Tenant-scoped Agents, write directly to the `agents.{soulMd|agentsMd|heartbeatMd|toolsMd|agentYml}` TEXT column.
8. **Activity row** — emit `AGENT_FILE_EDITED` with `details.diff` (truncated to 5 KB) and `details.runId`.

## 8. Recipe — concrete pseudocode for `AgentRunService.execute()`

```typescript
async execute(context: AgentRunContext): Promise<void> {
    const agent = await this.agents.findById(context.agentId);

    // 1. Pre-flight budget check
    const remaining = await this.budgetGuard.checkBudget({
        ownerType: 'agent',
        ownerId: agent.id,
        estimatedCostCents: this.estimateCost(agent, context)
    });
    if (remaining === 'block') {
        await this.runs.markFailed(context.runId, 'Budget exceeded');
        await this.activity.record({ actionType: 'AGENT_BUDGET_EXCEEDED', userId: agent.userId, details: { agentId: agent.id } });
        return;
    }

    // 2. Load assembly inputs (parallel)
    const [files, skills, scopeContext, recentRuns, recentActivity, advancedPrompts] = await Promise.all([
        this.files.loadAll(agent),
        this.skillBindings.resolveActive({ agentId: agent.id, ... }),
        this.scope.loadDescription(agent),
        this.runs.findRecent(agent.id, 5),
        this.activity.findRecent({ agentId: agent.id, limit: 20 }),
        agent.workId ? this.advancedPrompts.findByWorkId(agent.workId) : null
    ]);

    // 3. Assemble system message (§2)
    const systemMessage = this.promptAssembler.assemble({
        files,                  // SOUL/AGENTS/HEARTBEAT/TOOLS/agent.yml
        capabilities: agent.capabilities,
        skills,                 // progressive disclosure shape
        advancedPrompts,        // when relevant
        scopeContext,
        memory: { recentRuns, recentActivity },
        kind: context.kind      // 'heartbeat' | 'task' | 'chat'
    });

    // 4. Assemble user message (§3)
    const userMessage = this.promptAssembler.userMessage(context);

    // 5. Resolve provider + model via existing facade
    const response = await this.aiFacade.createChatCompletion({
        messages: [
            { role: 'system', content: systemMessage },
            { role: 'user',   content: userMessage }
        ],
        tools: this.tools.resolveAllowedTools(agent),
        // routing:
        complexity: 'medium',   // 'simple' | 'medium' | 'complex' — Agent runs default to medium
    }, {
        userId: agent.userId,
        workId: agent.workId,
        providerOverride: agent.aiProviderId ?? undefined,
        // new field for run-level cost attribution
        agentId: agent.id,
        taskId: context.taskId
    });

    // 6. Handle tool loop (separate concern; not shown)
    await this.toolLoop.run(agent, context, response);

    // 7. Finalize
    await this.runs.markCompleted(context.runId, { summary: this.summarizer.summarize(response) });
}
```

## 9. Streaming vs non-streaming

For heartbeats and tasks: **non-streaming** by default. The Agent returns a single response; no UI is waiting on incremental output. Saves a code path.

For chat replies: **streaming**, so the chat panel shows incremental typing. Use `createStreamingChatCompletion()` and pipe chunks into `task_chat_messages.body` updates (debounced 250 ms). The final `[DONE]` frame flushes the row.

## 10. References

- [`agents-skills-tasks.md`](./agents-skills-tasks.md) — cross-cutting architecture.
- [`ai-facade.md`](./ai-facade.md) — provider resolution and cost tracking.
- [`activity-log.md`](./activity-log.md) — event taxonomy.
- [`../features/agents/spec.md`](../features/agents/spec.md) — Agent product spec.
- [`../features/agents/plan.md`](../features/agents/plan.md) — Agent implementation plan.
- [`../features/skills/spec.md`](../features/skills/spec.md) — Skill resolution and injection rules.
- [`../decisions/006-agents-skills-tasks-as-core-not-plugins.md`](../decisions/006-agents-skills-tasks-as-core-not-plugins.md) — design decision.
