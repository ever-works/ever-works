# Architecture: Agent tools catalog

**Status**: `Draft`
**Last updated**: 2026-05-25
**Audience**: Engineers implementing the tool-loop in `AgentRunService`. Defines the canonical set of tools exposed to a user-defined Agent during a run, including arg schemas, response shapes, error envelopes, permission gates, and side-effects.

> Every tool listed here is exposed to the AI provider via the existing tool-loop helper that today serves `agent-pipeline` / `claude-code` plugins. The new `AgentRunService.execute()` calls `this.tools.resolveAllowedTools(agent)` (see [`agent-prompt-assembly.md` §8](./agent-prompt-assembly.md)) and the returned list is passed to `AiFacadeService.createChatCompletion({tools})`.
>
> **Permission gates are evaluated server-side at tool-invocation time.** A tool may be visible in the catalog (descriptive only — surfaces in `TOOLS.md`) but rejected at call time. The tool returns a structured error to the AI; the AI handles it (usually by asking the user or skipping the action). No "this tool doesn't exist" responses — every gated tool returns `permission_denied` consistently.

---

## 1. Tool surface

| Tool name         | Purpose                                                        | Permission gate                                         | Cost                                                         |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| `createTask`      | Create a task scoped to the Agent's scope                      | `permissions.canAssignTasks`                            | 1 DB write + 1 activity row                                  |
| `commentOnTask`   | Append a chat message on a Task the Agent participates in      | (none — Agent must be assignee/reviewer/approver)       | 1 DB write + 1 activity row + maybe AI dispatch (if mention) |
| `transitionTask`  | Move a Task's status                                           | `permissions.canAssignTasks`                            | 1 DB write + 1 activity row                                  |
| `editAgentFile`   | Edit one of the Agent's own MD files                           | `permissions.canEditAgentFiles`                         | 1 Git commit OR 1 DB row + 1 activity row                    |
| `commitToRepo`    | Write arbitrary file(s) to the scope's repo                    | `permissions.canCommitToRepo`                           | N Git commits + N activity rows                              |
| `openPullRequest` | Open a PR against the scope's repo (escalation over commit)    | `permissions.canCommitToRepo` AND `canOpenPullRequests` | 1 PR + 1 activity row                                        |
| `createSubAgent`  | Create a new Agent within the parent's scope                   | `permissions.canCreateAgents` AND scope cascade rules   | 1 DB write + 1 Git commit (if Git-mode) + 1 activity row     |
| `getActivity`     | Read recent activity log rows for this Agent's scope           | (none — always allowed)                                 | 1 DB read; capped output                                     |
| `getMissionState` | Read state summary of a Mission the Agent has access to        | (none — must be in Agent's scope)                       | 1 DB read                                                    |
| `getKbDocument`   | Read a KB document body by slug                                | (none — must be in Agent's scope)                       | 1 DB read                                                    |
| `getSkillBody`    | Fetch the full body of a Skill (progressive disclosure)        | (none — must be in active set for this Agent)           | 1 DB or Git read                                             |
| `searchWeb`       | Web search via the active search plugin                        | `permissions.canCallExternalTools` AND plugin enabled   | 1 plugin call + 1 PluginUsageEvent                           |
| `screenshot`      | Capture a screenshot of a URL via the active screenshot plugin | same                                                    | same                                                         |
| `extractContent`  | Extract content from a URL via the content-extractor plugin    | same                                                    | same                                                         |

The first eight are **platform tools** — implemented in `AgentToolService` and don't go through the plugin facade. The last three are **plugin tools** — proxied to existing facade services (Search, Screenshot, Content-Extractor) and inherit those plugins' rate limits and errors.

## 2. Error envelope (shared by all tools)

Every tool either returns its success shape (see per-tool sections below) OR a structured error:

```typescript
type ToolError = {
	error: {
		code:
			| 'permission_denied'
			| 'not_found'
			| 'validation_failed'
			| 'budget_exceeded'
			| 'rate_limited'
			| 'precondition_failed'
			| 'provider_error'
			| 'internal_error';
		message: string; // human-readable; safe for the AI to relay
		details?: Record<string, unknown>;
	};
};
```

The AI sees the error and decides how to react (retry, ask the user, skip). Errors are **never silently swallowed**.

## 3. Per-tool specifications

### 3.1 `createTask`

```typescript
input: {
    title: string;                          // 1..200 chars
    description?: string;                   // markdown, 0..50_000 chars
    priority?: 'p0' | 'p1' | 'p2' | 'p3' | 'p4';  // default 'p3'
    labels?: string[];
    assigneeAgentSlugs?: string[];           // resolved server-side; rejected if out of scope
    assigneeUserIds?: string[];              // for human assignees
    parentTaskSlug?: string;                 // optional sub-task
    blockedBySlugs?: string[];               // optional blockers
    scope?: { workId?: string; missionId?: string; ideaId?: string }; // defaults to parent agent's scope
}
output: { slug: string; id: string; status: 'backlog' | 'todo' };
```

**Side-effects**: insert `tasks` row + N `task_assignees` + M `task_blocks` + 1 `activity_log` (`TASK_CREATED`). If any assignee is an Agent and the Task is created in `todo` status with auto-start, dispatch `agent-task-execute` runs.

**Permission gate**: `canAssignTasks = true`. Cross-scope assignee rules per [architecture §3](./agents-skills-tasks.md). Out-of-scope assignee → `permission_denied` with `details.outOfScope: <slug>`.

### 3.2 `commentOnTask`

```typescript
input: {
    taskSlug: string;
    body: string;                            // markdown, 1..10_000 chars
    mentions?: { type: 'user' | 'agent'; slug: string }[];
}
output: { messageId: string };
```

**Side-effects**: insert `task_chat_messages` row + 1 `activity_log` (`TASK_COMMENTED`). If any mention is an Agent assignee on the task, dispatch `agent-chat-reply` run (deduped by `chatMessageId`).

**Permission gate**: caller Agent must already be on the Task (assignee/reviewer/approver). Otherwise `permission_denied`.

### 3.3 `transitionTask`

```typescript
input: {
    taskSlug: string;
    to: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
    reason?: string;                         // shown in activity log
}
output: { status: typeof input.to };
```

**Side-effects**: update `tasks.status` (validated by `TaskTransitionService`) + 1 `activity_log` (`TASK_UPDATED`). On `→ done`: validate approvers if any.

**Permission gate**: `canAssignTasks = true`. State machine violations → `validation_failed`.

### 3.4 `editAgentFile`

```typescript
input: {
    name: 'SOUL.md' | 'AGENTS.md' | 'HEARTBEAT.md' | 'TOOLS.md' | 'agent.yml';
    body: string;                            // ≤ 64 KB
    expectedHash?: string;                   // optional ETag for optimistic concurrency
    commitMessage?: string;                  // optional; default "chore(agent/<slug>): self-edit"
}
output: { newHash: string };
```

**Side-effects**: Git commit (Mission/Work scope) OR DB write (Tenant scope) + update `agents.contentHash` + 1 `activity_log` (`AGENT_FILE_EDITED`).

**Permission gate**: `canEditAgentFiles = true`. **At most one file edit per run** (frequency cap). **Secret scan** on `body` — reject on match. **Hash mismatch** with `expectedHash` → `precondition_failed`.

### 3.5 `commitToRepo`

```typescript
input: {
    files: { path: string; content: string; mode: 'add' | 'modify' | 'delete' }[];
    commitMessage: string;
    branch?: string;                         // defaults to repo default branch
    targetRepo: 'data' | 'website' | 'mission';  // implicit by Agent scope
}
output: { sha: string; branch: string };
```

**Side-effects**: 1 Git commit + N file changes + 1 `activity_log` (new type `AGENT_COMMITTED_TO_REPO`).

**Permission gate**: `canCommitToRepo = true`. Path validation prevents traversal (`..`). Files must be under the Agent's scope tree — Agents cannot commit outside their scope's repo.

### 3.6 `openPullRequest`

```typescript
input: {
	files: {
		path: string;
		content: string;
		mode: 'add' | 'modify' | 'delete';
	}
	[];
	branchName: string; // new branch
	title: string;
	body: string; // PR description
	targetRepo: 'data' | 'website' | 'mission';
}
output: {
	prUrl: string;
	prNumber: number;
}
```

**Side-effects**: create branch + N file changes + 1 PR + 1 `activity_log` (new type `AGENT_OPENED_PR`).

**Permission gate**: `canCommitToRepo = true` AND `canOpenPullRequests = true`. The latter exists as a deliberate escalation — committing is per-Agent default; PR review involves humans more directly.

### 3.7 `createSubAgent`

```typescript
input: {
    name: string;
    title?: string;
    capabilities: string;
    scope: 'tenant' | 'mission' | 'idea' | 'work';
    targetId?: string;                       // mission/idea/work id; null for tenant
    aiProviderId?: string;
    modelId?: string;
    heartbeatCadence?: string;               // cron or 'manual'
    permissions?: Partial<AgentPermissions>;
}
output: { agentId: string; slug: string };
```

**Side-effects**: insert `agents` row in status `draft` (sub-agents NEVER auto-activate; user must explicitly Start) + scaffold MD files in scope repo + 1 `activity_log` (`AGENT_CREATED` with `details.createdByAgentId`).

**Permission gate**: `canCreateAgents = true`. Scope cascade per [architecture §3](./agents-skills-tasks.md): tenant→any, mission→same Mission, work→same Work. Permissions on the new sub-Agent default to `false` for every flag — caller cannot set permissions ON for the child.

### 3.8 `getActivity`

```typescript
input: {
    since?: string;                          // ISO datetime; default last 24h
    types?: string[];                        // filter by ActivityActionType; default all
    limit?: number;                          // 1..100; default 20
}
output: {
    rows: { id: string; actionType: string; createdAt: string; summary: string; details?: object }[];
    truncated: boolean;
};
```

**Side-effects**: none.

**Permission gate**: none. Scoped by Agent's reach automatically — only rows whose `workId`/`missionId`/`ideaId` is in the Agent's scope are returned.

### 3.9 `getMissionState`

```typescript
input: {
	missionSlugOrId: string;
}
output: {
	id: string;
	title: string;
	description: string;
	status: 'active' | 'paused' | 'completed' | 'failed';
	ideas: {
		open: number;
		queued: number;
		building: number;
		done: number;
		failed: number;
	}
	worksCount: number;
	spend: {
		currentSpendCents: number;
		capCents: number | null;
		periodEnd: string;
	}
}
```

**Side-effects**: none.

**Permission gate**: Mission must be in Agent's scope (Mission-scoped Agent reads own; Tenant Agent reads any member Mission). Otherwise `not_found` (don't reveal existence).

### 3.10 `getKbDocument`

```typescript
input: {
    slug: string;                            // KB document slug
    workId?: string;                         // ambiguous slug across Works requires this
}
output: { id: string; title: string; body: string; updatedAt: string };
```

**Side-effects**: none.

**Permission gate**: caller must be in scope of the KB's owning Work/Mission. KB documents may be poisoned with prompt injection — see [`security-agents-skills-tasks.md` §3](./security-agents-skills-tasks.md) for sandboxing.

### 3.11 `getSkillBody`

```typescript
input: { slug: string };
output: { name: string; description: string; body: string; allowedTools: string[]; examples?: { input: string; output: string }[] };
```

**Side-effects**: emit `SKILL_INVOKED` activity row.

**Permission gate**: Skill must be in the Agent's active set (resolved per the binding hierarchy). Otherwise `not_found`.

### 3.12 Plugin tools (`searchWeb`, `screenshot`, `extractContent`)

These pass through to the existing facade services (`SearchFacadeService`, `ScreenshotFacadeService`, `ContentExtractorFacadeService`) with `providerOverride = agent.aiProviderId ?? undefined` and `userId` / `workId` from the Agent context. The facade resolves the plugin via the same 3-tier cascade. Cost/usage rows are written via the existing `PluginUsageEvent` flow with `agentId` set.

**Input/output shapes** are identical to today's facade call signatures and are not duplicated here. Reference: [`ai-facade.md`](./ai-facade.md) and the per-capability service in `packages/agent/src/facades/`.

**Permission gate**: `canCallExternalTools = true` + the plugin must be enabled at the Agent's scope.

## 4. Tool list assembly at run time

The set of tools registered with the AI call for a given run is computed by `AgentToolService.resolveAllowedTools(agent)`:

```typescript
const tools: ToolDefinition[] = [];

// 1. Always-on read tools
tools.push(getActivity, getMissionState, getKbDocument, getSkillBody);

// 2. Permission-gated platform tools
if (agent.permissions.canAssignTasks) tools.push(createTask, transitionTask);
tools.push(commentOnTask); // gated at call-time by Agent's task participation
if (agent.permissions.canEditAgentFiles) tools.push(editAgentFile);
if (agent.permissions.canCommitToRepo) {
	tools.push(commitToRepo);
	if (agent.permissions.canOpenPullRequests) tools.push(openPullRequest);
}
if (agent.permissions.canCreateAgents) tools.push(createSubAgent);

// 3. Plugin tools (only when external calls allowed AND plugin enabled in scope)
if (agent.permissions.canCallExternalTools) {
	if (await isPluginEnabled(agent, 'search')) tools.push(searchWeb);
	if (await isPluginEnabled(agent, 'screenshot')) tools.push(screenshot);
	if (await isPluginEnabled(agent, 'content-extractor')) tools.push(extractContent);
}

return tools;
```

The exact `ToolDefinition` shape matches the LangChain tool format already in use by `agent-pipeline` plugins, so the AI provider needs no special handling.

## 5. Telemetry per tool call

Every tool invocation emits one row in `agent_run_logs` with:

- `step = 'tool:<toolName>'`
- `level = INFO | WARN | ERROR`
- `message = '<short summary or error code>'`
- `metadata = { args (truncated 1 KB), durationMs, costCents (if plugin-tool) }`

This is read by the Agent's Activity tab and surfaces in Sentry on errors.

## 6. References

- [`agents-skills-tasks.md`](./agents-skills-tasks.md) — overall architecture.
- [`agent-prompt-assembly.md`](./agent-prompt-assembly.md) — where tools fit in prompt assembly.
- [`security-agents-skills-tasks.md`](./security-agents-skills-tasks.md) — threat model + secret-scan + path-traversal mitigations.
- [`../features/agents/spec.md`](../features/agents/spec.md) — Agent product spec.
- [`../features/task-tracking/spec.md`](../features/task-tracking/spec.md) — Task product spec (createTask/transitionTask/commentOnTask consumers).
- ADR-006: [`../decisions/006-agents-skills-tasks-as-core-not-plugins.md`](../decisions/006-agents-skills-tasks-as-core-not-plugins.md).
