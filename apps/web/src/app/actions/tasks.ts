'use server';

import { revalidatePath } from 'next/cache';
import { tasksAPI, type Task, type TaskPriority, type TaskStatus } from '@/lib/api/tasks';

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

export async function updateTaskAction(id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'labels' | 'parentTaskId' | 'requireAllApprovers'>>): Promise<Task> {
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

export async function transitionTaskAction(id: string, to: TaskStatus, force = false): Promise<Task> {
    const task = await tasksAPI.transition(id, to, force);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}
