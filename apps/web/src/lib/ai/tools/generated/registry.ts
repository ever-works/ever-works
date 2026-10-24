import type { HttpMethod } from './api-call';
import {
    TASK_CREATE_ALLOWED_FIELDS,
    TASK_PRIVILEGED_FIELDS,
    TASK_UPDATE_ALLOWED_FIELDS,
    changesTaskLabels,
    createsStartedTask,
    mentionsSomeone,
    redirectsNotificationChannel,
    redirectsWebhook,
    startsTaskWork,
    touchesAgentPrivileges,
} from './privileged';

/**
 * Manifest-driven chat-tool registry.
 *
 * Each entry maps ONE platform API operation to ONE chat tool. The factory
 * (`./factory.ts`) turns every entry into a Vercel AI SDK `tool()` whose
 * `execute` routes through the authenticated API client — so adding chat
 * coverage for a new operation is a data edit here, not new imperative code.
 *
 * This mirrors the MCP server's `apps/mcp/src/openapi-tools/whitelist.ts`
 * curation model, but emits web-chat tools instead of MCP tools.
 *
 * RULES baked into the registry (see docs/specs/features/chat-everything):
 *  - SINGLE ENTITY ONLY. Never register bulk/batch/delete-all endpoints.
 *  - `requiresConfirmation: true` on every destructive/irreversible/spendy op
 *    — the factory refuses to run it until the model re-calls with
 *    `confirmed: true`, which only happens after the user agrees in chat.
 *
 * ## Naming convention (decided; applies to NEW tools only)
 *
 * `snake_case`, action verb + singular noun (`get_digest`,
 * `review_pull_request`). Every one of this manifest's entries already
 * follows it, and so do the newer platform-side domain tools, so this is
 * the majority convention on both sides — it is now the rule for anything
 * added from here on.
 *
 * The platform's ORIGINAL built-in tools are camelCase (`searchWeb`,
 * `sendEmail`, `createTask`), as are the hand-written web tools in the
 * sibling `*.tools.ts` files (`listWorks`, `createMission`). Those are
 * NOT renamed: a tool name is part of a live model contract and appears
 * in stored conversation histories, so a rename breaks replay for zero
 * user-visible gain. The split is documented rather than churned — see
 * `docs/specs/features/chat-everything/README.md`.
 */

export type OperationKind = 'read' | 'create' | 'update' | 'destructive' | 'action';

export interface OperationParam {
    name: string;
    in: 'path' | 'query';
    required?: boolean;
    type?: 'string' | 'number' | 'boolean';
    description?: string;
}

export interface OperationSpec {
    /** Chat tool name exposed to the model (snake_case, action + singular noun). */
    toolName: string;
    method: HttpMethod;
    /** Full controller path with `{param}` placeholders, e.g. `/api/agents/{id}`. */
    path: string;
    /** One-line description — becomes the tool description shown to the model. */
    summary: string;
    kind: OperationKind;
    /** Path + query parameters. Body is handled generically via a `body` object. */
    params?: OperationParam[];
    /** Whether the operation accepts a JSON request body. */
    body?: boolean;
    /** Human hint listing the expected body fields (helps the model fill `body`). */
    bodyHint?: string;
    /** Destructive / irreversible / spend-incurring — gated behind confirmation. */
    requiresConfirmation?: boolean;
    /**
     * Per-call confirmation: gate only the calls this predicate flags (e.g. a
     * task-chat post that @mentions someone, an agent update that touches
     * permissions). A throwing predicate fails closed. Ignored when
     * `requiresConfirmation` is already true.
     */
    confirmWhen?: (args: Record<string, unknown>) => boolean;
    /**
     * Security: `privileged` marks an op that is reversible but changes what
     * agents can do, know or are told (permissions, agent files, skills,
     * memory, advanced prompts, org documents). Such writes must be the
     * user's own call, because an injected tool result (an email, an event,
     * a KB doc read earlier in the same turn) can otherwise steer the model
     * into making them. Defaults to `destructive` wording.
     */
    confirmationKind?: 'destructive' | 'privileged';
    /**
     * Security (works-security, 2026-10-18): the request-body ALLOWLIST for an
     * operation whose DTO mixes everyday fields with controls. The factory
     * forwards only `allowed` + `privileged` keys (anything else is dropped
     * and reported back as `ignoredFields`), and a call that carries any
     * `privileged` key needs the user's confirmation (privileged card, with a
     * preview of exactly those fields) — the control stays usable, one click
     * away, but never on the model's say-so alone.
     */
    bodyFields?: {
        allowed: readonly string[];
        privileged?: readonly string[];
    };
    /**
     * Security: refuse the call when any string argument (path, query or
     * body, nested) carries something that looks like a credential. For tools
     * that hand a URL or text to a third party (screenshot, web search), where
     * a planted instruction could otherwise smuggle a key out in the query.
     */
    refuseSecretArgs?: boolean;
    /**
     * Security: response fields that hold a one-time secret (a freshly minted
     * API key). They are lifted out of the result into `__secretOnce`, which
     * the chat UI shows to the user once; the model is never shown the value
     * and the conversation store never saves it.
     */
    secretResultFields?: readonly string[];
    /** Optional canvas artifact this result renders nicely as (documentation only). */
    canvas?: string;
}

const id = (desc = 'The entity id'): OperationParam => ({
    name: 'id',
    in: 'path',
    required: true,
    type: 'string',
    description: desc,
});

const workId: OperationParam = {
    name: 'workId',
    in: 'path',
    required: true,
    type: 'string',
    description: 'The Work id',
};

/**
 * WAVE 1 seed — single-entity operations across domains the chat agent did
 * NOT previously cover (agents, tasks, skills, notifications, members,
 * api-keys, budgets/usage, webhooks, orgs, KB, templates, plugins).
 *
 * Works / items / missions / ideas / deploy / schedule already ship as
 * hand-written tools in the sibling `*.tools.ts` files, so they are not
 * duplicated here. Later waves extend this array (validated against the
 * controllers by the inventory workflow) toward full UI parity.
 */
export const OPERATION_REGISTRY: OperationSpec[] = [
    // ── Agents ───────────────────────────────────────────────────
    {
        toolName: 'list_agents',
        method: 'GET',
        path: '/api/agents',
        summary: 'List the current user’s agents.',
        kind: 'read',
        params: [{ name: 'status', in: 'query', type: 'string', description: 'Filter by status' }],
        canvas: 'AgentList',
    },
    {
        toolName: 'get_agent',
        method: 'GET',
        path: '/api/agents/{id}',
        summary: 'Get one agent’s details.',
        kind: 'read',
        params: [id('Agent id')],
        canvas: 'AgentDetail',
    },
    {
        toolName: 'create_agent',
        method: 'POST',
        path: '/api/agents',
        summary: 'Create a new agent.',
        kind: 'create',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        body: true,
        bodyHint: 'name, title, scope, scopeId, aiProvider, model, capabilities[].',
    },
    {
        toolName: 'list_agent_templates',
        method: 'GET',
        path: '/api/agents/templates',
        summary:
            'List prebuilt agent templates (marketing/sales/ops presets with prompts, suggested skills, and a suggested pipeline).',
        kind: 'read',
    },
    {
        toolName: 'create_agent_from_template',
        method: 'POST',
        path: '/api/agents/from-template/{slug}',
        summary:
            'Create an agent for the current user from a prebuilt template (draft status, review-before-act guardrails).',
        kind: 'create',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        params: [
            {
                name: 'slug',
                in: 'path',
                required: true,
                type: 'string',
                description: 'Template slug from list_agent_templates (e.g. outreach-drafter)',
            },
        ],
        body: true,
        bodyHint: 'Optional placement overrides: name, scope, missionId, ideaId, workId.',
    },
    {
        toolName: 'update_agent',
        method: 'PATCH',
        path: '/api/agents/{id}',
        summary: 'Update an agent’s fields.',
        kind: 'update',
        confirmWhen: touchesAgentPrivileges,
        confirmationKind: 'privileged',
        params: [id('Agent id')],
        body: true,
        bodyHint:
            'Any of: name, title, model, capabilities, permissions, avatar, heartbeatCadence.',
    },
    {
        toolName: 'delete_agent',
        method: 'DELETE',
        path: '/api/agents/{id}',
        summary: 'Archive (soft-delete) an agent.',
        kind: 'destructive',
        params: [id('Agent id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'pause_agent',
        method: 'POST',
        path: '/api/agents/{id}/pause',
        summary: 'Pause an active agent.',
        kind: 'action',
        params: [id('Agent id')],
    },
    {
        toolName: 'resume_agent',
        method: 'POST',
        path: '/api/agents/{id}/resume',
        summary: 'Resume a paused agent.',
        kind: 'action',
        params: [id('Agent id')],
        // Works-security: a resumed agent starts heartbeat runs on its own
        // cadence (spend + autonomous work) — the user's call, like run_agent_now.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'run_agent_now',
        method: 'POST',
        path: '/api/agents/{id}/run-now',
        summary: 'Trigger an agent heartbeat run immediately.',
        kind: 'action',
        params: [id('Agent id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'list_agent_runs',
        method: 'GET',
        path: '/api/agents/{id}/runs',
        summary: 'List an agent’s run history.',
        kind: 'read',
        params: [id('Agent id')],
        canvas: 'AgentRunsTable',
    },
    {
        toolName: 'get_agent_skills',
        method: 'GET',
        path: '/api/agents/{id}/skills',
        summary: 'Get the skills bound to an agent.',
        kind: 'read',
        params: [id('Agent id')],
    },
    {
        toolName: 'get_agent_budget',
        method: 'GET',
        path: '/api/agents/{id}/budget',
        summary: 'Get an agent’s current-period spend.',
        kind: 'read',
        params: [id('Agent id')],
    },
    {
        toolName: 'assign_task_to_agent',
        method: 'POST',
        path: '/api/agents/{id}/assign-task',
        summary: 'Assign a task to an agent.',
        kind: 'action',
        params: [id('Agent id')],
        body: true,
        bodyHint: 'taskId.',
        // Works-security: the route pre-creates an AgentRun and enqueues it —
        // it STARTS a run, exactly like run_agent_now.
        requiresConfirmation: true,
    },

    // ── Meetings (Wave 8, feature a) ─────────────────────────────
    {
        toolName: 'list_meetings',
        method: 'GET',
        path: '/api/meetings',
        summary:
            'List the current user’s captured meetings (synced recordings, imported and manual), newest first — org-wide or filtered to one Work. Rows carry a sourceUrl recording link.',
        kind: 'read',
        params: [
            {
                name: 'workId',
                in: 'query',
                type: 'string',
                description: 'Only meetings routed to this Work',
            },
            {
                name: 'source',
                in: 'query',
                type: 'string',
                description: 'Filter by source: zoom, google-meet, manual or import',
            },
            { name: 'limit', in: 'query', type: 'number', description: 'Max rows (default 20)' },
        ],
    },
    {
        toolName: 'get_meeting_summary',
        method: 'GET',
        path: '/api/meetings/{id}',
        summary:
            'Get one meeting’s AI summary, transcript and metadata (participants, timing, recording link). Use after list_meetings when asked what a meeting covered or decided.',
        kind: 'read',
        params: [id('Meeting id (from list_meetings)')],
    },

    // ── Fleet (Wave 12, slice 1) ─────────────────────────────────
    {
        toolName: 'list_fleet_nodes',
        method: 'GET',
        path: '/api/fleet/nodes',
        summary:
            'List the current user’s fleet — the machines enrolled to execute their work (desktop and headless nodes) plus live nodes of their own configured clusters. Each node carries kind, online/offline status, capability tags, platform and last-seen time.',
        kind: 'read',
        params: [],
    },

    // ── Event ingest, digest and PR review ───────────────────────
    //
    // The three tools the platform had and the web side structurally
    // could not: this manifest binds tools to REST operations, and until
    // the receiver/endpoint work landed there was no owner-scoped REST
    // route behind any of them. Registering them here is what makes the
    // platform and web tool surfaces finally agree.
    {
        toolName: 'list_recent_events',
        method: 'GET',
        path: '/api/ingest/events',
        summary:
            'List the current user’s recent external events ingested from connected sources (GitHub pull requests and @ever-works mentions, Slack, calendar and other connectors), newest first — optionally narrowed to one Work or one source. Use when asked what has been happening, what came in recently, or what a source has reported.',
        kind: 'read',
        params: [
            {
                name: 'workId',
                in: 'query',
                type: 'string',
                description: 'Only events routed to this Work',
            },
            {
                name: 'source',
                in: 'query',
                type: 'string',
                description: 'Filter by producing plugin id, e.g. github or slack',
            },
            { name: 'limit', in: 'query', type: 'number', description: 'Max rows (default 20)' },
        ],
    },
    {
        toolName: 'get_digest',
        method: 'GET',
        path: '/api/digest',
        summary:
            'Get the current user’s activity digest for the day or the week — agent runs completed and failed, tasks done and in review, pull requests opened, ingested events by source, and progress on active goals — rendered as markdown plus a one-line summary. Use when asked for a catch-up, a standup, a recap or "what happened".',
        kind: 'read',
        params: [
            {
                name: 'period',
                in: 'query',
                type: 'string',
                description: 'Digest window: daily (default) or weekly',
            },
        ],
    },
    {
        toolName: 'review_pull_request',
        method: 'POST',
        path: '/api/pr-review',
        summary:
            'Run the Work-aware AI reviewer on a pull request and post the review as a comment on it. The repository must be connected to one of the current user’s Works. Optionally takes a reviewer instruction to focus the review.',
        kind: 'action',
        body: true,
        bodyHint: 'owner, repo, prNumber, and optionally instruction and workId.',
        // Posts a public comment on someone’s pull request and spends
        // model credits on the diff — irreversible and spendy, so the
        // user confirms in chat before it runs.
        requiresConfirmation: true,
    },

    // ── Merge policy (Wave 3, founder decision D4) ───────────────
    {
        toolName: 'resolve_merge_policy',
        method: 'GET',
        path: '/api/merge-policy/resolve',
        summary:
            'Resolve the effective merge policy for a Work and/or Agent — whether agents may merge their own pull requests, whether a green quality gate and/or a human approval is required, which merge methods are allowed and which branches are protected. Also reports which scope (tenant, organization, Work, Agent or the platform default) each setting came from. Use when the user asks who may merge, why a merge was refused, or what the current policy is.',
        kind: 'read',
        params: [
            {
                name: 'workId',
                in: 'query',
                type: 'string',
                description: 'Resolve the policy as it applies to this Work.',
            },
            {
                name: 'agentId',
                in: 'query',
                type: 'string',
                description:
                    'Resolve the policy as it applies to this Agent (most specific scope; its Work, organization and tenant are discovered automatically).',
            },
        ],
    },

    // ── Tasks ────────────────────────────────────────────────────
    {
        toolName: 'list_tasks',
        method: 'GET',
        path: '/api/tasks',
        summary: 'List the current user’s tasks.',
        kind: 'read',
        params: [
            { name: 'status', in: 'query', type: 'string' },
            { name: 'missionId', in: 'query', type: 'string' },
        ],
        canvas: 'TaskList',
    },
    {
        toolName: 'get_task',
        method: 'GET',
        path: '/api/tasks/{id}',
        summary: 'Get one task’s details.',
        kind: 'read',
        params: [id('Task id')],
        canvas: 'TaskDetail',
    },
    {
        toolName: 'create_task',
        method: 'POST',
        path: '/api/tasks',
        summary: 'Create a new task.',
        kind: 'create',
        body: true,
        bodyHint:
            'title (required), description, priority, status (backlog or todo; anything else needs confirmation), dueAt, startAt, estimateMinutes, labels, missionId, ideaId, workId, parentTaskId. Needs the user’s confirmation: agentId, scheduledAt, teamId, goalId, acceptanceChecks, requireAllApprovers, isolationMode, maxGateAttempts, extraRepos (array of { repoConnectionId, mountDir?, writable? } — repository-registry connection ids; extra repositories mounted next to the Work’s repository when the task runs on a fleet node).',
        // Works-security (2026-10-18): an injected email or Task text could
        // otherwise have the assistant file a Task whose setup command runs
        // on a fleet node, or one assigned/scheduled to an agent. Everyday
        // fields go straight through; the controls need a confirmation.
        bodyFields: { allowed: TASK_CREATE_ALLOWED_FIELDS, privileged: TASK_PRIVILEGED_FIELDS },
        confirmWhen: createsStartedTask,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'update_task',
        method: 'PATCH',
        path: '/api/tasks/{id}',
        summary: 'Update a task’s fields (use transition_task to change its status).',
        kind: 'update',
        params: [id('Task id')],
        body: true,
        bodyHint:
            'Any of: title, description, priority, dueAt, startAt, estimateMinutes, missionId, ideaId, workId, parentTaskId. Needs the user’s confirmation: labels (the list is replaced), agentId, scheduledAt, teamId, goalId, acceptanceChecks, requireAllApprovers, isolationMode, maxGateAttempts, extraRepos (array of { repoConnectionId, mountDir?, writable? } — repository-registry connection ids; null clears).',
        // Works-security (2026-10-18): see create_task.
        bodyFields: { allowed: TASK_UPDATE_ALLOWED_FIELDS, privileged: TASK_PRIVILEGED_FIELDS },
        confirmWhen: changesTaskLabels,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'delete_task',
        method: 'DELETE',
        path: '/api/tasks/{id}',
        summary: 'Delete a task.',
        kind: 'destructive',
        params: [id('Task id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'transition_task',
        method: 'POST',
        path: '/api/tasks/{id}/transition',
        summary: 'Move a task to a new status.',
        kind: 'action',
        params: [id('Task id')],
        body: true,
        bodyHint:
            'to (required: backlog, todo, in_progress, in_review, blocked, done or cancelled). Moving to in_progress, in_review, done or cancelled can start agent runs and needs the user’s confirmation, as does force.',
        // Works-security (2026-10-18): `→ in_progress` dispatches every
        // assigned agent, `→ in_review` plans reviewer runs, and `→ done` /
        // `cancelled` release dependents (which can start theirs). `force`
        // skips the approver gate.
        bodyFields: { allowed: ['to', 'mode'], privileged: ['force'] },
        confirmWhen: startsTaskWork,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'add_task_assignee',
        method: 'POST',
        path: '/api/tasks/{id}/assignees',
        summary: 'Add a single assignee to a task.',
        kind: 'update',
        params: [id('Task id')],
        body: true,
        bodyHint: 'assigneeId.',
    },
    {
        toolName: 'add_task_reviewer',
        method: 'POST',
        path: '/api/tasks/{id}/reviewers',
        summary: 'Add a reviewer to a task.',
        kind: 'update',
        params: [id('Task id')],
        body: true,
        bodyHint: 'reviewerId.',
    },
    {
        toolName: 'add_task_approver',
        method: 'POST',
        path: '/api/tasks/{id}/approvers',
        summary: 'Add an approver to a task.',
        kind: 'update',
        params: [id('Task id')],
        body: true,
        bodyHint: 'approverId.',
    },
    {
        toolName: 'get_task_chat',
        method: 'GET',
        path: '/api/tasks/{id}/chat',
        summary: 'Get a task’s chat messages.',
        kind: 'read',
        params: [id('Task id')],
    },
    {
        toolName: 'post_task_chat',
        method: 'POST',
        path: '/api/tasks/{id}/chat',
        summary: 'Post a message to a task’s chat.',
        kind: 'create',
        confirmWhen: mentionsSomeone,
        confirmationKind: 'privileged',
        params: [id('Task id')],
        body: true,
        bodyHint: 'content.',
    },
    {
        toolName: 'get_task_spend',
        method: 'GET',
        path: '/api/tasks/{id}/spend',
        summary: 'Get a task’s budget usage.',
        kind: 'read',
        params: [id('Task id')],
    },

    // ── Skills ───────────────────────────────────────────────────
    {
        toolName: 'list_skills',
        method: 'GET',
        path: '/api/skills',
        summary: 'List the current user’s skills.',
        kind: 'read',
        canvas: 'SkillList',
    },
    {
        toolName: 'get_skill',
        method: 'GET',
        path: '/api/skills/{id}',
        summary: 'Get one skill’s details.',
        kind: 'read',
        params: [id('Skill id')],
    },
    {
        toolName: 'create_skill',
        method: 'POST',
        path: '/api/skills',
        summary: 'Create a new skill.',
        kind: 'create',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        body: true,
        bodyHint: 'name, description, definition.',
    },
    {
        toolName: 'update_skill',
        method: 'PATCH',
        path: '/api/skills/{id}',
        summary: 'Update a skill.',
        kind: 'update',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        params: [id('Skill id')],
        body: true,
        bodyHint: 'Any of: name, description, definition.',
    },
    {
        toolName: 'delete_skill',
        method: 'DELETE',
        path: '/api/skills/{id}',
        summary: 'Delete a skill.',
        kind: 'destructive',
        params: [id('Skill id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'browse_skill_catalog',
        method: 'GET',
        path: '/api/skills/catalog',
        summary: 'Browse the skill catalog.',
        kind: 'read',
        canvas: 'SkillCatalog',
    },
    {
        toolName: 'install_skill',
        method: 'POST',
        path: '/api/skills/install',
        summary: 'Install a skill from the catalog.',
        kind: 'create',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        body: true,
        bodyHint: 'slug.',
    },
    {
        toolName: 'list_skill_bindings',
        method: 'GET',
        path: '/api/skills/{id}/bindings',
        summary: 'List a skill’s bindings.',
        kind: 'read',
        params: [id('Skill id')],
    },
    {
        toolName: 'create_skill_binding',
        method: 'POST',
        path: '/api/skills/{id}/bindings',
        summary: 'Bind a skill to an agent.',
        kind: 'create',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        params: [id('Skill id')],
        body: true,
        bodyHint: 'agentId, priority.',
    },
    {
        toolName: 'delete_skill_binding',
        method: 'DELETE',
        path: '/api/skill-bindings/{id}',
        summary: 'Remove a skill binding.',
        kind: 'destructive',
        params: [id('Skill binding id')],
        requiresConfirmation: true,
    },

    // ── Notifications ────────────────────────────────────────────
    {
        toolName: 'list_notifications',
        method: 'GET',
        path: '/api/notifications',
        summary: 'List notifications.',
        kind: 'read',
        canvas: 'NotificationList',
    },
    {
        toolName: 'get_unread_notifications_count',
        method: 'GET',
        path: '/api/notifications/unread-count',
        summary: 'Get the unread notification count.',
        kind: 'read',
    },
    {
        toolName: 'mark_notification_read',
        method: 'POST',
        path: '/api/notifications/{id}/read',
        summary: 'Mark a notification as read.',
        kind: 'update',
        params: [id('Notification id')],
    },
    {
        toolName: 'mark_all_notifications_read',
        method: 'POST',
        path: '/api/notifications/read-all',
        summary: 'Mark all notifications as read.',
        kind: 'update',
    },
    {
        toolName: 'dismiss_notification',
        method: 'POST',
        path: '/api/notifications/{id}/dismiss',
        summary: 'Dismiss a notification.',
        kind: 'update',
        params: [id('Notification id')],
    },
    {
        toolName: 'list_notification_channels',
        method: 'GET',
        path: '/api/notification-channels',
        summary: 'List notification channels.',
        kind: 'read',
    },
    {
        toolName: 'create_notification_channel',
        method: 'POST',
        path: '/api/notification-channels',
        summary: 'Create a notification channel.',
        kind: 'create',
        body: true,
        bodyHint: 'type, name, config.',
        // Works-security: a channel is a destination the platform sends
        // notification content to — an injected one would forward it out.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'update_notification_channel',
        method: 'PATCH',
        path: '/api/notification-channels/{id}',
        summary: 'Update a notification channel.',
        kind: 'update',
        params: [id('Channel id')],
        body: true,
        bodyHint: 'Any of: name, config, enabled.',
        // Works-security: changing `config` re-points the destination.
        confirmWhen: redirectsNotificationChannel,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'delete_notification_channel',
        method: 'DELETE',
        path: '/api/notification-channels/{id}',
        summary: 'Delete a notification channel.',
        kind: 'destructive',
        params: [id('Channel id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'test_notification_channel',
        method: 'POST',
        path: '/api/notification-channels/{id}/test',
        summary: 'Send a test notification to a channel.',
        kind: 'action',
        params: [id('Channel id')],
    },

    // ── API keys ─────────────────────────────────────────────────
    {
        toolName: 'list_api_keys',
        method: 'GET',
        path: '/api/auth/api-keys',
        summary: 'List the current user’s API keys.',
        kind: 'read',
    },
    {
        toolName: 'create_api_key',
        method: 'POST',
        path: '/api/auth/api-keys',
        summary: 'Create a new API key.',
        kind: 'create',
        body: true,
        bodyHint: 'name, optional expiresAt/scopes.',
        // Works-security: a personal key acts as the user everywhere. It is
        // minted only on the user's confirmation, and the plaintext key goes
        // to the user's screen once — never into the model's context (where a
        // later tool call could carry it out) or the stored conversation.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        secretResultFields: ['key'],
    },
    {
        toolName: 'revoke_api_key',
        method: 'DELETE',
        path: '/api/auth/api-keys/{id}',
        summary: 'Revoke an API key.',
        kind: 'destructive',
        params: [id('API key id')],
        requiresConfirmation: true,
    },

    // ── Work members & invitations ───────────────────────────────
    {
        toolName: 'list_work_members',
        method: 'GET',
        path: '/api/works/{workId}/members',
        summary: 'List a Work’s members.',
        kind: 'read',
        params: [workId],
        canvas: 'MemberList',
    },
    {
        toolName: 'add_work_member',
        method: 'POST',
        path: '/api/works/{workId}/members',
        summary: 'Add a member to a Work.',
        kind: 'create',
        params: [workId],
        body: true,
        bodyHint: 'userId or email, role.',
        // Works-security: grants a person access to the Work.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'update_work_member',
        method: 'PUT',
        path: '/api/works/{workId}/members/{memberId}',
        summary: 'Update a Work member’s role.',
        kind: 'update',
        params: [workId, { name: 'memberId', in: 'path', required: true, type: 'string' }],
        body: true,
        bodyHint: 'role.',
        // Works-security: changes what a person may do on the Work.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'remove_work_member',
        method: 'DELETE',
        path: '/api/works/{workId}/members/{memberId}',
        summary: 'Remove a member from a Work.',
        kind: 'destructive',
        params: [workId, { name: 'memberId', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },
    {
        toolName: 'invite_work_member',
        method: 'POST',
        path: '/api/works/{workId}/invitations',
        summary: 'Invite someone to a Work by email.',
        kind: 'create',
        params: [workId],
        body: true,
        bodyHint: 'email, role.',
        // Works-security: sends an email and grants access once accepted.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'list_work_invitations',
        method: 'GET',
        path: '/api/works/{workId}/invitations',
        summary: 'List pending invitations for a Work.',
        kind: 'read',
        params: [workId],
    },
    {
        toolName: 'cancel_work_invitation',
        method: 'DELETE',
        path: '/api/works/{workId}/invitations/{invitationId}',
        summary: 'Cancel a pending Work invitation.',
        kind: 'destructive',
        params: [workId, { name: 'invitationId', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },

    // ── Budgets & usage (reports) ────────────────────────────────
    {
        toolName: 'list_work_budgets',
        method: 'GET',
        path: '/api/works/{workId}/budgets',
        summary: 'List a Work’s budgets.',
        kind: 'read',
        params: [workId],
    },
    {
        toolName: 'create_work_budget',
        method: 'POST',
        path: '/api/works/{workId}/budgets',
        summary: 'Create a budget for a Work.',
        kind: 'create',
        params: [workId],
        body: true,
        bodyHint: 'cap, currency, scope (global or pluginId), overageBehaviour.',
        // Works-security: a budget decides how much the platform may spend.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'update_work_budget',
        method: 'PATCH',
        path: '/api/works/{workId}/budgets/{budgetId}',
        summary: 'Update a Work budget.',
        kind: 'update',
        params: [workId, { name: 'budgetId', in: 'path', required: true, type: 'string' }],
        body: true,
        bodyHint: 'Any of: cap, overageBehaviour.',
        // Works-security: raising a cap / changing overage allows more spend.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'delete_work_budget',
        method: 'DELETE',
        path: '/api/works/{workId}/budgets/{budgetId}',
        summary: 'Delete a Work budget.',
        kind: 'destructive',
        params: [workId, { name: 'budgetId', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },
    {
        toolName: 'get_work_usage_summary',
        method: 'GET',
        path: '/api/works/{workId}/usage/summary',
        summary: 'Get a Work’s spend summary for the current period.',
        kind: 'read',
        params: [workId],
        canvas: 'UsageSummary',
    },
    {
        toolName: 'get_work_usage_trend',
        method: 'GET',
        path: '/api/works/{workId}/usage/trend',
        summary: 'Get a Work’s daily spend trend (good for a chart).',
        kind: 'read',
        params: [workId],
        canvas: 'UsageTrendChart',
    },
    {
        toolName: 'get_account_usage',
        method: 'GET',
        path: '/api/me/usage/account-wide',
        summary: 'Get the user’s total spend and cap status across all works.',
        kind: 'read',
        canvas: 'UsageSummary',
    },

    // ── Webhooks ─────────────────────────────────────────────────
    {
        toolName: 'list_webhooks',
        method: 'GET',
        path: '/api/webhooks',
        summary: 'List webhooks.',
        kind: 'read',
    },
    {
        toolName: 'create_webhook',
        method: 'POST',
        path: '/api/webhooks',
        summary: 'Create a webhook.',
        kind: 'create',
        body: true,
        bodyHint: 'url, events[], optional secret.',
        // Works-security: a webhook ships event payloads to an outside URL.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'update_webhook',
        method: 'PATCH',
        path: '/api/webhooks/{id}',
        summary: 'Update a webhook.',
        kind: 'update',
        params: [id('Webhook id')],
        body: true,
        bodyHint: 'Any of: url, events, enabled.',
        // Works-security: changing url / events re-points what goes out.
        confirmWhen: redirectsWebhook,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'delete_webhook',
        method: 'DELETE',
        path: '/api/webhooks/{id}',
        summary: 'Delete a webhook.',
        kind: 'destructive',
        params: [id('Webhook id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'test_webhook',
        method: 'POST',
        path: '/api/webhooks/{id}/test',
        summary: 'Send a test delivery to a webhook.',
        kind: 'action',
        params: [id('Webhook id')],
    },
    {
        toolName: 'rotate_webhook_secret',
        method: 'POST',
        path: '/api/webhooks/{id}/rotate-secret',
        summary: 'Rotate a webhook’s signing secret.',
        kind: 'action',
        params: [id('Webhook id')],
        requiresConfirmation: true,
    },
    {
        toolName: 'list_webhook_deliveries',
        method: 'GET',
        path: '/api/webhooks/deliveries',
        summary: 'List recent webhook deliveries.',
        kind: 'read',
    },

    // ── Organizations ────────────────────────────────────────────
    {
        toolName: 'list_organizations',
        method: 'GET',
        path: '/api/organizations',
        summary: 'List the user’s organizations.',
        kind: 'read',
    },
    {
        toolName: 'get_organization',
        method: 'GET',
        path: '/api/organizations/{slug}',
        summary: 'Get an organization by slug.',
        kind: 'read',
        params: [{ name: 'slug', in: 'path', required: true, type: 'string' }],
    },
    {
        toolName: 'create_organization',
        method: 'POST',
        path: '/api/organizations',
        summary: 'Create an organization.',
        kind: 'create',
        body: true,
        bodyHint: 'name, slug.',
    },
    {
        toolName: 'update_organization',
        method: 'PATCH',
        path: '/api/organizations/{id}',
        summary: 'Update an organization.',
        kind: 'update',
        params: [id('Organization id')],
        body: true,
        bodyHint: 'Any of: name, slug, settings.',
    },
    {
        toolName: 'check_organization_slug',
        method: 'GET',
        path: '/api/organizations/check-slug',
        summary: 'Check if an organization slug is available.',
        kind: 'read',
        // The controller declares the query param as `value` (CheckSlugQueryDto.value).
        params: [
            {
                name: 'value',
                in: 'query',
                required: true,
                type: 'string',
                description: 'The slug to check for availability',
            },
        ],
    },

    // ── Knowledge base ───────────────────────────────────────────
    {
        toolName: 'list_kb_documents',
        method: 'GET',
        path: '/api/works/{id}/kb/documents',
        summary: 'List a Work’s knowledge-base documents.',
        kind: 'read',
        params: [id('Work id')],
    },
    {
        toolName: 'create_kb_document',
        method: 'POST',
        path: '/api/works/{id}/kb/documents',
        summary: 'Create a knowledge-base document.',
        kind: 'create',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        params: [id('Work id')],
        body: true,
        bodyHint: 'path, title, content.',
    },
    {
        toolName: 'update_kb_document',
        method: 'PATCH',
        path: '/api/works/{id}/kb/documents/{docId}',
        summary: 'Update a knowledge-base document.',
        kind: 'update',
        requiresConfirmation: true,
        confirmationKind: 'privileged',
        params: [id('Work id'), { name: 'docId', in: 'path', required: true, type: 'string' }],
        body: true,
        bodyHint: 'Any of: title, content.',
    },
    {
        toolName: 'delete_kb_document',
        method: 'DELETE',
        path: '/api/works/{id}/kb/documents/{docId}',
        summary: 'Delete a knowledge-base document.',
        kind: 'destructive',
        params: [id('Work id'), { name: 'docId', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },
    {
        toolName: 'list_kb_tags',
        method: 'GET',
        path: '/api/works/{id}/kb/tags',
        summary: 'List knowledge-base tags for a Work.',
        kind: 'read',
        params: [id('Work id')],
    },
    {
        toolName: 'create_kb_tag',
        method: 'POST',
        path: '/api/works/{id}/kb/tags',
        summary: 'Create a knowledge-base tag.',
        kind: 'create',
        params: [id('Work id')],
        body: true,
        bodyHint: 'name, optional color.',
    },

    // ── Templates ────────────────────────────────────────────────
    {
        toolName: 'list_templates',
        method: 'GET',
        path: '/api/templates',
        summary: 'List available website templates.',
        kind: 'read',
    },
    {
        toolName: 'create_custom_template',
        method: 'POST',
        path: '/api/templates/custom',
        summary: 'Create a custom website template.',
        kind: 'create',
        body: true,
        bodyHint: 'name, baseTemplateId, settings.',
    },
    {
        toolName: 'set_default_template',
        method: 'PUT',
        path: '/api/templates/default',
        summary: 'Set the default website template.',
        kind: 'update',
        body: true,
        bodyHint: 'templateId.',
    },
    {
        toolName: 'fork_template',
        method: 'POST',
        path: '/api/templates/fork',
        summary: 'Fork an existing template.',
        kind: 'create',
        body: true,
        bodyHint: 'templateId, name.',
    },

    // ── Plugins & integrations ───────────────────────────────────
    {
        toolName: 'list_plugins',
        method: 'GET',
        path: '/api/plugins',
        summary: 'List available plugins and whether each is enabled.',
        kind: 'read',
        canvas: 'PluginList',
    },
    {
        toolName: 'get_plugin',
        method: 'GET',
        path: '/api/plugins/{pluginId}',
        summary: 'Get a plugin’s details and settings schema.',
        kind: 'read',
        params: [{ name: 'pluginId', in: 'path', required: true, type: 'string' }],
    },
    {
        toolName: 'get_plugin_connection_status',
        method: 'GET',
        path: '/api/plugins/{pluginId}/connection-status',
        summary: 'Check a plugin’s connection status.',
        kind: 'read',
        params: [{ name: 'pluginId', in: 'path', required: true, type: 'string' }],
    },
    {
        toolName: 'enable_plugin',
        method: 'POST',
        path: '/api/plugins/{pluginId}/enable',
        summary: 'Enable a plugin for the account.',
        kind: 'action',
        params: [{ name: 'pluginId', in: 'path', required: true, type: 'string' }],
        // Works-security: a plugin gains access to the account's data and
        // can become the provider every model call goes through.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'disable_plugin',
        method: 'POST',
        path: '/api/plugins/{pluginId}/disable',
        summary: 'Disable a plugin for the account.',
        kind: 'action',
        params: [{ name: 'pluginId', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },
    {
        toolName: 'update_plugin_settings',
        method: 'PATCH',
        path: '/api/plugins/{pluginId}/settings',
        summary: 'Update a plugin’s settings.',
        kind: 'update',
        params: [{ name: 'pluginId', in: 'path', required: true, type: 'string' }],
        body: true,
        bodyHint: 'settings object matching the plugin schema.',
        // Works-security: settings hold secrets and base URLs — one changed
        // base URL redirects every model call (and its prompts) elsewhere.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'enable_work_plugin',
        method: 'POST',
        path: '/api/works/{workId}/plugins/{pluginId}/enable',
        summary: 'Enable a plugin for a specific Work.',
        kind: 'action',
        params: [workId, { name: 'pluginId', in: 'path', required: true, type: 'string' }],
        // Works-security: same as enable_plugin, for one Work.
        requiresConfirmation: true,
        confirmationKind: 'privileged',
    },
    {
        toolName: 'disable_work_plugin',
        method: 'POST',
        path: '/api/works/{workId}/plugins/{pluginId}/disable',
        summary: 'Disable a plugin for a specific Work.',
        kind: 'action',
        params: [workId, { name: 'pluginId', in: 'path', required: true, type: 'string' }],
        requiresConfirmation: true,
    },
];
