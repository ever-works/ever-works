'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import {
    tasksAPI,
    type ListTasksQuery,
    type Task,
    type TaskChatMessage,
    type TaskPriority,
    type TaskStatus,
} from '@/lib/api/tasks';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

export async function createTaskAction(input: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[];
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    parentTaskId?: string | null;
    /** Quality gates (Wave 3 M6) — acceptance checks declared at create. */
    acceptanceChecks?: TaskAcceptanceCheck[] | null;
    maxGateAttempts?: number | null;
}): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.create(input);
    revalidatePath('/tasks');
    return task;
}

export async function updateTaskAction(
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
        >
    >,
): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.update(id, patch);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

export async function deleteTaskAction(id: string): Promise<{ deleted: true }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await tasksAPI.remove(id);
    revalidatePath('/tasks');
    return res;
}

export async function transitionTaskAction(
    id: string,
    to: TaskStatus,
    force = false,
): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.transition(id, to, force);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

/**
 * Kanban run cockpit (Wave 2) — read-only refresh used by the board's
 * run-chip polling hook. Re-fetches the user's tasks WITH the latest-run
 * embed (`includeRun=true`); the client merges run data by task id, so a
 * plain, filter-free page (bounded limit) is sufficient. No
 * revalidatePath on purpose — this is a poll, not a mutation.
 */
export async function listTasksWithRunsAction(
    query: Omit<ListTasksQuery, 'includeRun'> = {},
): Promise<Task[]> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const result = await tasksAPI.list({
        ...query,
        limit: Math.min(200, query.limit ?? 200),
        includeRun: true,
    });
    return result.data;
}

/**
 * Wave 2 M7 — re-run the Task agent to resolve a workspace merge
 * conflict. The API answers 409 when the branch is not in a conflict
 * state; the resulting error message is surfaced to the caller.
 */
export async function resolveTaskConflictsAction(id: string): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.resolveConflicts(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

/**
 * Wave 2 M7 — delete the Task branch and reset its workspace
 * identity. Irreversible; the UI confirms before calling this.
 */
export async function discardTaskBranchAction(id: string): Promise<{ ok: true }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await tasksAPI.discardBranch(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return res;
}

export async function postTaskChatAction(taskId: string, body: string): Promise<TaskChatMessage> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const message = await tasksAPI.postChat(taskId, body);
    revalidatePath(`/tasks/${taskId}`);
    return message;
}

export async function editTaskChatAction(
    messageId: string,
    body: string,
): Promise<TaskChatMessage> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    return tasksAPI.editChat(messageId, body);
}

/**
 * Phase 17.8 UI — promote a Task to a recurring template. The
 * service-layer validates the RRULE and computes the first
 * `nextOccurrenceAt`; the dispatcher (`task-recurrence-dispatcher`)
 * spawns instances on schedule.
 */
export async function setTaskRecurringAction(
    id: string,
    input: {
        recurrenceRule: string;
        recurrenceTimezone?: string;
        recurrenceEndsAt?: string;
        recurrenceMaxOccurrences?: number;
    },
): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.setRecurring(id, input);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

/**
 * Phase 17.8 UI — demote a recurring template back to a plain
 * Task. Existing spawned instances are NOT cascaded — they keep
 * their `parentRecurringTaskId` pointer and continue to live as
 * independent rows.
 */
export async function clearTaskRecurringAction(id: string): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.clearRecurring(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

// FU-5 — attachment server actions. The actual upload (multipart →
// /api/uploads) happens client-side via the proxy route at
// `apps/web/src/app/api/uploads/route.ts`; once the client has the
// returned uploadId, it calls `attachUploadAction` to wire it into the
// Task via the existing `POST /api/tasks/:id/attachments` endpoint.

export async function attachUploadAction(taskId: string, uploadId: string) {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const row = await tasksAPI.addAttachment(taskId, uploadId);
    revalidatePath(`/tasks/${taskId}`);
    return row;
}

export async function detachAttachmentAction(taskId: string, attachmentId: string) {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await tasksAPI.removeAttachment(taskId, attachmentId);
    revalidatePath(`/tasks/${taskId}`);
    return res;
}
