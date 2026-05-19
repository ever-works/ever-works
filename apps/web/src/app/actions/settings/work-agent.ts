'use server';

import { revalidatePath } from 'next/cache';
import type {
    CreateWorkAgentGoalInput,
    UpdateWorkAgentPreferencesInput,
} from '@/lib/api/work-agent';
import { workAgentAPI } from '@/lib/api/work-agent';

const SETTINGS_PATH = '/[locale]/(dashboard)/settings/work-agent';

export async function updateWorkAgentPreferencesAction(input: UpdateWorkAgentPreferencesInput) {
    const result = await workAgentAPI.updatePreferences(input);
    revalidatePath(SETTINGS_PATH, 'page');
    return result;
}

export async function createWorkAgentGoalAction(input: CreateWorkAgentGoalInput) {
    const result = await workAgentAPI.createGoal(input);
    revalidatePath(SETTINGS_PATH, 'page');
    return result;
}

export async function cancelWorkAgentGoalAction(goalId: string) {
    const result = await workAgentAPI.cancelGoal(goalId);
    revalidatePath(SETTINGS_PATH, 'page');
    return result;
}
