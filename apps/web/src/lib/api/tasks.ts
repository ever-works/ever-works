import 'server-only';
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
