'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { taskTemplatesAPI } from '@/lib/api/task-templates';
import type {
    InstantiateTemplateInput,
    TaskTemplateRow,
} from '@/lib/api/task-templates.shared';
import type { Task } from '@/lib/api/tasks';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Tasks upgrades — workflow Task Template actions. Listing seeds the
 * default "Compound Engineering Workflow" server-side on first call.
 */
export async function listTaskTemplatesAction(): Promise<TaskTemplateRow[]> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const { data } = await taskTemplatesAPI.list();
    return data;
}

/**
 * Expand a template into a parent Task + one sub-task per step
 * (dependencies as blockers, per-step agents as assignees, approval
 * gates as approvers) — one transaction server-side.
 */
export async function instantiateTaskTemplateAction(
    templateId: string,
    input: InstantiateTemplateInput,
): Promise<{ parentTask: Task; subtasks: Task[] }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const result = await taskTemplatesAPI.instantiate(templateId, input);
    revalidatePath('/tasks');
    return result;
}

export async function deleteTaskTemplateAction(templateId: string): Promise<{ deleted: true }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await taskTemplatesAPI.remove(templateId);
    revalidatePath('/tasks/templates');
    return res;
}
