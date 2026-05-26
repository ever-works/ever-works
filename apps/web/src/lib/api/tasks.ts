import 'server-only';
import { serverFetch, serverMutation } from './server-api';

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
        } catch {
            return null;
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
    }) {
        return serverMutation<Task>({
            endpoint: '/tasks',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'labels' | 'parentTaskId' | 'requireAllApprovers'>>) {
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

    async transition(id: string, to: TaskStatus, force = false) {
        return serverMutation<Task>({
            endpoint: `/tasks/${id}/transition`,
            data: { to, force },
            method: 'POST',
            wrapInData: false,
        });
    },
};
