'use server';

import { revalidatePath } from 'next/cache';
import {
    tasksAPI,
    type Task,
    type TaskChatMessage,
    type TaskPriority,
    type TaskStatus,
} from '@/lib/api/tasks';

export async function createTaskAction(input: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[];
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    parentTaskId?: string | null;
}): Promise<Task> {
    const task = await tasksAPI.create(input);
    revalidatePath('/tasks');
    return task;
}

export async function updateTaskAction(
    id: string,
    patch: Partial<
        Pick<
            Task,
            'title' | 'description' | 'priority' | 'labels' | 'parentTaskId' | 'requireAllApprovers'
        >
    >,
): Promise<Task> {
    const task = await tasksAPI.update(id, patch);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

export async function deleteTaskAction(id: string): Promise<{ deleted: true }> {
    const res = await tasksAPI.remove(id);
    revalidatePath('/tasks');
    return res;
}

export async function transitionTaskAction(
    id: string,
    to: TaskStatus,
    force = false,
): Promise<Task> {
    const task = await tasksAPI.transition(id, to, force);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

export async function postTaskChatAction(taskId: string, body: string): Promise<TaskChatMessage> {
    const message = await tasksAPI.postChat(taskId, body);
    revalidatePath(`/tasks/${taskId}`);
    return message;
}

export async function editTaskChatAction(
    messageId: string,
    body: string,
): Promise<TaskChatMessage> {
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
    const task = await tasksAPI.clearRecurring(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}
