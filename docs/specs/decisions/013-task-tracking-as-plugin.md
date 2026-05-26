# ADR-013: Task tracking is a plugin capability; "Ever Works Task Tracker" is the first-party plugin storing tasks in platform DB

## Status

**Accepted — 2026-05-25.** Operator instruction during round 6 review of PR [#1017](https://github.com/ever-works/ever-works/pull/1017). **Supersedes the relevant part of [ADR-006](./006-agents-skills-tasks-as-core-not-plugins.md)** (Tasks are no longer "core not plugin").

## Date

2026-05-25

## Context

ADR-006 (round 1) declared Tasks core, with a reserved-but-not-consumed `task-tracker` plugin capability for future Linear/JIRA/GitHub integrations. Round 6 review reversed this:

> "About 006-agents-skills-tasks-as-core-not-plugins.md — I think actually for Task tracking, that's a good idea to implement it as plugin in the first place! I.e. we can call it 'Ever Works Task Tracker' plugin and implement it and later will be 'Linear Task Tracker', 'JIRA Task Tracker', 'GitHub Task Tracker' plugins etc that can be enabled to replace our own plugin in each Tenant etc. So no, I don't agree with ADR, while tasks are core to the platform, actually task TRACKING (storage, etc) should be a plugin."

Crucial nuance from the operator: **the Task concept is still core; what becomes pluggable is the TRACKING — storage, sync, list/create/update operations.**

## Decision

**Task TRACKING is a plugin capability.** The platform defines plugin category `task-tracker` with the contract `ITaskTrackerPlugin`. The first-party plugin **"Ever Works Task Tracker"** is the default `task-tracker`, storing tasks in platform DB tables (the schema designed in [`features/task-tracking/plan.md`](../features/task-tracking/plan.md)).

Future community plugins can implement the same capability — e.g.:

- **Linear Task Tracker** — proxies create/list/update/delete to Linear's API.
- **JIRA Task Tracker** — same for Jira Cloud.
- **GitHub Issues Task Tracker** — backs tasks with GitHub Issues.
- **Asana Task Tracker** — same for Asana.

A tenant has **exactly one active `task-tracker` plugin** at a time (unlike Skills which support union). Switching trackers is a deliberate user action with a migration UI (export from old → import to new).

### What stays core

- **The Task CONCEPT** (its entities, state machine, relationships to Agents/Missions/Ideas/Works) is core.
- **The Tasks UI** — `/tasks` page, Task detail, Kanban view, Task tabs on Work/Mission/Idea pages. Plugin-agnostic.
- **The state-machine logic** (`TaskTransitionService`, blocker cycle detection, approver gating).
- **The Agent integration** (a Task with an Agent assignee dispatches `agent-task-execute`).
- **The DTO contracts** in `@ever-works/contracts`.

### What moves into the plugin

- **Storage** — the `tasks`/`task_assignees`/`task_chat_messages`/etc. tables become the **"Ever Works Task Tracker"** plugin's storage. They're still TypeORM entities in `packages/agent/src/entities/`, but conceptually owned by the plugin.
- **CRUD operations** — `create`, `read`, `update`, `delete`, `transition` go through `ITaskTrackerPlugin`.
- **Chat operations** — `postMessage`, `listMessages` via the plugin.
- **Search / filter / list** — paginated list with filters.

### `ITaskTrackerPlugin` contract

```typescript
// packages/plugin/src/contracts/capabilities/task-tracker.interface.ts
export interface TaskDto {
	id: string;
	slug: string;
	title: string;
	description?: string;
	status: TaskStatus;
	priority: TaskPriority;
	labels: string[];
	scope: { workId?: string; missionId?: string; ideaId?: string };
	assignees: { type: 'user' | 'agent'; id: string }[];
	// ... full Task shape
}

export interface ITaskTrackerPlugin extends IPlugin {
	readonly providerName: string;

	// CRUD
	listTasks(options: ListTasksOptions): Promise<{ tasks: TaskDto[]; total: number }>;
	getTask(id: string): Promise<TaskDto | null>;
	createTask(input: CreateTaskInput, context: TaskContext): Promise<TaskDto>;
	updateTask(id: string, patch: UpdateTaskInput, context: TaskContext): Promise<TaskDto>;
	deleteTask(id: string, context: TaskContext): Promise<void>;

	// State machine
	transitionTask(id: string, to: TaskStatus, context: TaskContext): Promise<TaskDto>;

	// Assignees / reviewers / approvers (mutations)
	addAssignee(id: string, assignee: { type: 'user' | 'agent'; id: string }): Promise<void>;
	removeAssignee(id: string, assigneeId: string): Promise<void>;
	// ... reviewers, approvers, blockers, relations

	// Chat
	listChat(taskId: string, options: { limit: number; cursor?: string }): Promise<{ messages: ChatMessageDto[] }>;
	postChat(taskId: string, body: PostChatInput, context: TaskContext): Promise<ChatMessageDto>;

	// Attachments
	listAttachments(taskId: string): Promise<AttachmentDto[]>;
	attachUpload(taskId: string, uploadId: string): Promise<void>;

	// Capability flags — for trackers that don't support certain features
	readonly supportsSubTasks: boolean;
	readonly supportsBlockers: boolean;
	readonly supportsApprovers: boolean;
	readonly supportsChat: boolean;
	readonly supportsAgentAssignees: boolean; // Linear/Jira/GH likely false
}
```

### `TasksFacadeService` (new)

Resolves the active `task-tracker` plugin for the user/work scope; delegates all task operations. The UI never talks to a plugin directly — always to the facade.

When `supportsAgentAssignees = false` (third-party trackers may not allow Agent assignees), the platform stores the Agent assignment in a side-table `task_agent_assignments(externalTaskId, agentId)` so Agent execution still works while the tracker stays clean.

## "Ever Works Task Tracker" — the first-party plugin

Lives at `packages/plugins/everworks-task-tracker/`. `package.json` `everworks.plugin` block:

```json
{
	"id": "everworks-task-tracker",
	"name": "Ever Works Task Tracker",
	"category": "task-tracker",
	"capabilities": ["task-tracker"],
	"defaultForCapabilities": ["task-tracker"],
	"visibility": "public",
	"settingsSchema": {
		/* (mostly empty — uses platform DB) */
	}
}
```

Implementation:

- All CRUD operations write to the existing `tasks` / `task_*` tables via the existing repositories (which live in `packages/agent/src/database/repositories/`).
- All capability flags are `true` (the only tracker that supports the full feature set).
- Bundles the Task templates loaded from [`ever-works/tasks`](https://github.com/ever-works/tasks) (per ADR-014) for the "+ New Task from template" flow.

## Consequences

### Positive

- **Symmetric with platform architecture.** Tasks join the plugin model — no carve-out.
- **Real path to Linear / Jira / GitHub Issues integration.** Each lands as its own plugin without refactoring core.
- **Per-tenant choice.** Tenants pick the tracker that fits their workflow.
- **First-party plugin still ships the rich default** — no compromise on feature set if user keeps the default.

### Negative

- **Per-plugin feature parity is uneven.** Linear doesn't have approvers; Jira's labels differ. The capability-flags mechanism handles this, but the UX must gracefully degrade.
- **Migration when switching trackers.** A user moving from "Ever Works Task Tracker" to "Linear Task Tracker" needs export/import. v1 doesn't ship this; switch = start fresh, with a clear warning.
- **Agent integration tightly coupled to first-party.** Agent assignees may not work on third-party trackers without the side-table workaround above.

### Mitigations

- **Capability flags** on each plugin allow the UI to gray out unsupported features (e.g. hide "Add approver" button when `supportsApprovers = false`).
- **Side-table for Agent assignees** keeps Agent execution working regardless of tracker.
- **Migration UI explicitly v2** — v1 documents that switching trackers means starting fresh; users with active tasks should not switch.

## What changes in the Task tracking feature spec

Product behavior in [`features/task-tracking/spec.md`](../features/task-tracking/spec.md) is unchanged for users running the default "Ever Works Task Tracker" plugin. What changes is the **implementation packaging**:

- `tasks` / `task_*` tables become the property of `everworks-task-tracker` plugin (still defined in `packages/agent/src/entities/`).
- All API endpoints (`/tasks/*`) route through `TasksFacadeService` instead of `TaskService` directly.
- The reserved `IExternalTaskTrackerPlugin` mentioned in [ADR-009 §3](./009-tasks-vs-items-vs-kb-distinction.md) is realized as `ITaskTrackerPlugin` here, and CONSUMED by v1 (no longer "reserved").

## Alternatives Considered

### 1. Keep Tasks as core (status quo of ADR-006)

**Rejected per operator instruction.** Misses the third-party tracker integration story.

### 2. Plugin for third-party trackers only; native = non-plugin

**Rejected.** "Native" code path and "plugin" code path would diverge over time. Better to make even native a plugin so all consumers go through one facade.

### 3. Single plugin only ("Ever Works Task Tracker"); no capability + no facade

**Rejected.** Locks the platform to a single tracker; no extension surface.

## Related

- ADR-006 (partially superseded — Tasks no longer "core not plugin").
- ADR-009 (Tasks vs Items vs KB distinction — still valid; this ADR doesn't change task concept's distinctness).
- ADR-012 (Skills as plugin — parallel decision).
- ADR-014 (No hardcoded catalogs — `ever-works/tasks` repo for task templates).
- [`features/task-tracking/spec.md`](../features/task-tracking/spec.md), [`features/task-tracking/plan.md`](../features/task-tracking/plan.md) — product behavior unchanged; implementation packaging updated.
