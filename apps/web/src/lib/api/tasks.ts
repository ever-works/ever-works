import 'server-only';
import type {
    DecisionConflictReportDto,
    GateStatus,
    TaskAcceptanceCheck,
} from '@ever-works/contracts';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';

export type TaskStatus =
    | 'backlog'
    | 'todo'
    | 'in_progress'
    | 'in_review'
    | 'blocked'
    | 'done'
    | 'cancelled';

export type TaskPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
export type TaskActorType = 'user' | 'agent';

/** Wave 2 M7 — per-Task isolation override ('on'/'off'; null = inherit
 *  the Work-level `taskIsolation` setting). */
export type TaskIsolationMode = 'on' | 'off';

/** Wave 2 M7 — lifecycle of the Task's isolated branch. */
export type TaskBranchState =
    | 'created'
    | 'pushed'
    | 'pr-open'
    | 'conflict'
    | 'merged'
    | 'discarded'
    | 'cleaned';

/** Kanban run cockpit (Wave 2) — AgentRun lifecycle mirrored on the board. */
export type TaskRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Kanban run cockpit (Wave 2) — compact latest-run embed attached to
 * list rows when `includeRun=true` is requested. `currentActivity` is
 * plain text by contract — never render it as markup.
 */
export interface TaskRun {
    id: string;
    status: TaskRunStatus;
    currentActivity: string | null;
    totalTokens: number | null;
    /**
     * Cost telemetry (Wave 4 M7) - settled run cost in integer cents.
     * Optional so a response from an older API (which does not send it)
     * still type-checks; the chip simply renders no cost.
     */
    costCents?: number | null;
    changedFilesCount: number | null;
    startedAt: string | null;
    /** Quality gates (Wave 3 M6) — latest-run gate verdict for the board
     *  chip. `null`/absent = the run has no gate verdict. */
    gateStatus?: GateStatus | null;
}

// ── PR insights (kanban M5 / M6) ──────────────────────────────────

/** Rolled-up CI verdict for the PR head, as the board's dot renders it. */
export type TaskCiState = 'passing' | 'failing' | 'pending' | 'unknown';

/** PR lifecycle as last observed from the git provider. */
export type TaskPrState = 'open' | 'draft' | 'closed' | 'merged';

/** One CI check on the PR head. All strings are PLAIN TEXT by contract. */
export interface TaskPrCheck {
    name: string;
    status: string;
    conclusion?: string | null;
    detailsUrl?: string;
}

export interface TaskPrStatus {
    taskId: string;
    prNumber: number | null;
    prUrl: string | null;
    prState: TaskPrState | null;
    ciState: TaskCiState | null;
    ciCheckedAt: string | null;
    checks: TaskPrCheck[];
    /** True when this came from the server cache with no provider call. */
    cached: boolean;
}

export interface TaskDiffFile {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    /** The server dropped this file's patch to honour the byte budget. */
    patchOmitted?: boolean;
}

export interface TaskDiff {
    taskId: string;
    source: 'pull-request' | 'compare';
    prNumber: number | null;
    prUrl: string | null;
    branchRef: string | null;
    baseRef: string | null;
    diff: {
        files: TaskDiffFile[];
        truncated: boolean;
        totalFiles: number;
        totalAdditions: number;
        totalDeletions: number;
        patchBytes: number;
    };
}

// ── Board dispatch (kanban M3 / M4) ───────────────────────────────

// The dispatch sentinels and the picker row shape are consumed by a
// `'use client'` component, so they live in a `server-only`-free module
// (`tasks.shared.ts`). Re-exported here so server-side callers keep one
// import site.
export {
    RUN_ALREADY_IN_FLIGHT,
    RUN_AGENT_AMBIGUOUS,
    RUN_NO_AGENT,
    RUN_AGENT_NOT_FOUND,
    type RunCandidateAgent,
    type TaskAssignCandidate,
    type TaskScopeKey,
} from './tasks.shared';
import type { RunCandidateAgent } from './tasks.shared';

export interface RunTaskResult {
    taskId: string;
    agentId: string;
    runId: string | null;
    dispatched: boolean;
    parked: boolean;
    queuedReason?: string;
    error?: string;
}

export type RunBatchItemResult =
    | { taskId: string; ok: true; run: RunTaskResult }
    | { taskId: string; ok: false; error: { code: string; message: string } };

export interface Task {
    id: string;
    userId: string;
    slug: string;
    title: string;
    description: string | null;
    status: TaskStatus;
    previousStatus: TaskStatus | null;
    priority: TaskPriority;
    labels: string[] | null;
    missionId: string | null;
    ideaId: string | null;
    workId: string | null;
    /**
     * The Agent this Task is filed under — one of the owner columns, and
     * the second step of run-agent resolution (assignees → this →
     * the Work default). Assigning it is what makes "Run" on Task detail
     * dispatch without asking which Agent to use.
     */
    agentId: string | null;
    parentTaskId: string | null;
    createdByType: TaskActorType;
    createdById: string;
    requireAllApprovers: boolean;
    startedAt: string | null;
    completedAt: string | null;
    isRecurring: boolean;
    recurrenceRule: string | null;
    recurrenceTimezone: string | null;
    nextOccurrenceAt: string | null;
    recurrenceEndsAt: string | null;
    recurrenceMaxOccurrences: number | null;
    recurrenceOccurredCount: number;
    parentRecurringTaskId: string | null;
    // Wave 2 M7 — worktree-per-Task isolation surface. All null when the
    // Task runs without an isolated branch.
    isolationMode: TaskIsolationMode | null;
    branchRef: string | null;
    branchState: TaskBranchState | null;
    baseSha: string | null;
    prNumber: number | null;
    prUrl: string | null;
    conflictPaths: string[] | null;
    // PR insights (kanban M5) — cached PR/CI verdict, refreshed by the
    // `task-pr-status-sync` cron. All null until the Task opens a PR.
    prState?: TaskPrState | null;
    ciState?: TaskCiState | null;
    ciCheckedAt?: string | null;
    prChecks?: TaskPrCheck[] | null;
    // Kanban run cockpit (Wave 2) — latest-run denorm columns + the
    // opt-in `run` embed (present only on `includeRun=true` responses).
    latestRunId?: string | null;
    latestRunStatus?: TaskRunStatus | null;
    run?: TaskRun | null;
    // Quality gates (Wave 3 M6) — acceptance checks declared on this Task.
    // `null` = inherit the Work's `checkDefaults` untouched.
    acceptanceChecks?: TaskAcceptanceCheck[] | null;
    /** Gate-attempt budget; `null` = inherit the Work default. */
    maxGateAttempts?: number | null;
    createdAt: string;
    updatedAt: string;
}

export interface ListTasksQuery {
    status?: TaskStatus | TaskStatus[];
    priority?: TaskPriority | TaskPriority[];
    missionId?: string;
    ideaId?: string;
    workId?: string;
    parentTaskId?: string;
    label?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /** Kanban run cockpit (Wave 2) — embed each row's latest AgentRun. */
    includeRun?: boolean;
}

function buildQuery(q: ListTasksQuery = {}): string {
    const params = new URLSearchParams();
    if (q.status) params.set('status', Array.isArray(q.status) ? q.status.join(',') : q.status);
    if (q.priority)
        params.set('priority', Array.isArray(q.priority) ? q.priority.join(',') : q.priority);
    if (q.missionId) params.set('missionId', q.missionId);
    if (q.ideaId) params.set('ideaId', q.ideaId);
    if (q.workId) params.set('workId', q.workId);
    if (q.parentTaskId) params.set('parentTaskId', q.parentTaskId);
    if (q.label) params.set('label', q.label);
    if (q.search) params.set('search', q.search);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    if (q.offset !== undefined) params.set('offset', String(q.offset));
    if (q.includeRun) params.set('includeRun', 'true');
    const s = params.toString();
    return s ? `?${s}` : '';
}

export const tasksAPI = {
    async list(query: ListTasksQuery = {}) {
        return serverFetch<{
            data: Task[];
            meta: { total: number; limit: number; offset: number };
        }>(`/tasks${buildQuery(query)}`, { method: 'GET' });
    },

    async get(id: string) {
        try {
            return await serverFetch<Task>(`/tasks/${id}`, { method: 'GET' });
        } catch (err) {
            if (err instanceof ApiResponseError && err.statusCode === 404) {
                return null;
            }
            throw err;
        }
    },

    async create(input: {
        title: string;
        description?: string | null;
        status?: TaskStatus;
        priority?: TaskPriority;
        labels?: string[];
        missionId?: string | null;
        ideaId?: string | null;
        workId?: string | null;
        parentTaskId?: string | null;
        requireAllApprovers?: boolean;
        isolationMode?: TaskIsolationMode | null;
        acceptanceChecks?: TaskAcceptanceCheck[] | null;
        maxGateAttempts?: number | null;
    }) {
        return serverMutation<Task>({
            endpoint: '/tasks',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(
        id: string,
        patch: Partial<
            Pick<
                Task,
                | 'title'
                | 'description'
                | 'priority'
                | 'labels'
                | 'parentTaskId'
                | 'requireAllApprovers'
                | 'isolationMode'
                | 'acceptanceChecks'
                | 'maxGateAttempts'
                | 'workId'
                | 'missionId'
                | 'ideaId'
                | 'agentId'
            >
        >,
    ) {
        return serverMutation<Task>({
            endpoint: `/tasks/${id}`,
            data: patch as Record<string, unknown>,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async remove(id: string) {
        return serverMutation<{ deleted: true }>({
            endpoint: `/tasks/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * Wave 2 M7 — re-run the Task agent to resolve a workspace merge
     * conflict. 409 when `branchState !== 'conflict'`.
     */
    async resolveConflicts(id: string) {
        return serverMutation<Task>({
            endpoint: `/tasks/${id}/resolve-conflicts`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Wave 2 M7 — delete the Task branch and reset its workspace
     * identity. Irreversible.
     */
    async discardBranch(id: string) {
        return serverMutation<{ ok: true }>({
            endpoint: `/tasks/${id}/discard-branch`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // ── Board dispatch (kanban M3 / M4) ───────────────────────────

    /** Agents the board's picker offers for this Task. */
    async listRunCandidates(id: string) {
        return serverFetch<{ data: RunCandidateAgent[] }>(`/tasks/${id}/run-candidates`, {
            method: 'GET',
        });
    },

    /**
     * PR insights (kanban M5) — cached PR state + CI verdict for this
     * Task's pull request. The server owns the refresh throttle, so the
     * client may call this as often as it likes.
     */
    async prStatus(id: string, opts: { refresh?: boolean } = {}) {
        return serverFetch<TaskPrStatus>(
            `/tasks/${id}/pr-status${opts.refresh ? '?refresh=true' : ''}`,
            { method: 'GET' },
        );
    },

    /**
     * PR insights (kanban M6) — capped diff for this Task's PR (or its
     * pushed branch). `maxFiles`/`maxBytes` may only narrow the platform
     * caps; the API clamps anything larger.
     */
    async diff(id: string, opts: { maxFiles?: number; maxBytes?: number } = {}) {
        const params = new URLSearchParams();
        if (opts.maxFiles !== undefined) params.set('maxFiles', String(opts.maxFiles));
        if (opts.maxBytes !== undefined) params.set('maxBytes', String(opts.maxBytes));
        const query = params.toString();
        return serverFetch<TaskDiff>(`/tasks/${id}/diff${query ? `?${query}` : ''}`, {
            method: 'GET',
        });
    },
    /**
     * Re-litigation guard (memory upgrades M6) — settled decisions this
     * Task appears to re-open. Deterministic term-overlap check on the
     * API side; advisory only, never blocking. Returns
     * `{ conflicts, scanned, heuristic }`.
     */
    async decisionConflicts(id: string) {
        return serverFetch<DecisionConflictReportDto>(`/tasks/${id}/decision-conflicts`, {
            method: 'GET',
        });
    },

    /**
     * Run the Task now. `agentId` omitted lets the server resolve it;
     * an ambiguous / empty resolution answers 400 with a `code` +
     * `candidates` body the caller turns into the picker.
     */
    async run(id: string, agentId?: string | null) {
        return serverMutation<RunTaskResult>({
            endpoint: `/tasks/${id}/run`,
            data: agentId ? { agentId } : {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Run several Tasks at once — per-item results, never all-or-nothing. */
    async runBatch(items: { taskId: string; agentId?: string | null }[]) {
        return serverMutation<{ results: RunBatchItemResult[] }>({
            endpoint: `/tasks/run-batch`,
            data: {
                items: items.map((item) => ({
                    taskId: item.taskId,
                    ...(item.agentId ? { agentId: item.agentId } : {}),
                })),
            },
            method: 'POST',
            wrapInData: false,
        });
    },

    async transition(id: string, to: TaskStatus, force = false) {
        return serverMutation<Task>({
            endpoint: `/tasks/${id}/transition`,
            data: { to, force },
            method: 'POST',
            wrapInData: false,
        });
    },

    async listChat(id: string, opts: { limit?: number; offset?: number } = {}) {
        const params = new URLSearchParams();
        if (opts.limit !== undefined) params.set('limit', String(opts.limit));
        if (opts.offset !== undefined) params.set('offset', String(opts.offset));
        const qs = params.toString();
        return serverFetch<{ data: TaskChatMessage[] }>(`/tasks/${id}/chat${qs ? `?${qs}` : ''}`, {
            method: 'GET',
        });
    },

    async postChat(id: string, body: string, attachments?: { uploadId: string }[]) {
        return serverMutation<TaskChatMessage>({
            endpoint: `/tasks/${id}/chat`,
            data: { body, attachments },
            method: 'POST',
            wrapInData: false,
        });
    },

    async editChat(messageId: string, body: string) {
        return serverMutation<TaskChatMessage>({
            endpoint: `/task-chat-messages/${messageId}`,
            data: { body },
            method: 'PATCH',
            wrapInData: false,
        });
    },

    /**
     * Phase 17.8 UI — promote a Task to a recurring template.
     *
     * `recurrenceRule` is an RRULE string per RFC 5545 (e.g.
     * `FREQ=WEEKLY;BYDAY=MO`). `TasksService.setRecurring`
     * validates the rule + computes the first `nextOccurrenceAt`
     * from now; rejects rules with no future occurrences.
     */
    async setRecurring(
        id: string,
        input: {
            recurrenceRule: string;
            recurrenceTimezone?: string;
            recurrenceEndsAt?: string;
            recurrenceMaxOccurrences?: number;
        },
    ) {
        return serverMutation<Task>({
            endpoint: `/tasks/${id}/recurring`,
            data: input as Record<string, unknown>,
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Phase 17.8 UI — demote a recurring template back to a plain
     * Task (clears `isRecurring` + all recurrence columns).
     */
    async clearRecurring(id: string) {
        return serverMutation<Task>({
            endpoint: `/tasks/${id}/recurring`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // FU-5 — attachments.
    async listAttachments(id: string): Promise<TaskAttachmentRow[]> {
        return serverFetch<TaskAttachmentRow[]>(`/tasks/${id}/attachments`, { method: 'GET' });
    },

    async addAttachment(id: string, uploadId: string): Promise<TaskAttachmentRow> {
        return serverMutation<TaskAttachmentRow>({
            endpoint: `/tasks/${id}/attachments`,
            data: { uploadId },
            method: 'POST',
            wrapInData: false,
        });
    },

    async removeAttachment(id: string, attachmentId: string): Promise<{ deleted: true }> {
        return serverMutation<{ deleted: true }>({
            endpoint: `/tasks/${id}/attachments/${attachmentId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};

/**
 * FU-5 — Task attachment row as surfaced by
 * `GET /api/tasks/:id/attachments`. Mirrors the `TaskAttachment`
 * entity columns + the joined upload metadata the service returns so
 * the UI doesn't need a second hop.
 */
export interface TaskAttachmentRow {
    id: string;
    taskId: string;
    uploadId: string;
    createdAt: string;
    upload?: {
        id: string;
        filename: string;
        contentType: string;
        sizeBytes: number;
        downloadUrl?: string;
    } | null;
}

export interface TaskChatMention {
    type: 'user' | 'agent' | 'kb';
    id?: string;
    slug?: string;
}

export interface TaskChatMessage {
    id: string;
    taskId: string;
    authorType: TaskActorType;
    authorId: string;
    body: string;
    mentions: TaskChatMention[] | null;
    attachments: { uploadId: string }[] | null;
    editedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
