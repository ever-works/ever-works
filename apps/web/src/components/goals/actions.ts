'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { goalsAPI, type CreateGoalInput, type UpdateGoalInput } from '@/lib/api/goals';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Goals & Metrics — PR-8. Server actions backing the Goals UI. Each
 * one forwards to the JWT-protected `/api/me/goals` surface and busts
 * the relevant page caches, mirroring the Missions actions
 * (`app/actions/dashboard/missions.ts`). Lives alongside the Goals
 * components so the whole surface ships in one directory.
 */

// Security: defense-in-depth auth guard at the web layer. All Goal
// server actions forward straight to the JWT-protected API; this
// rejects unauthenticated callers before any request is issued,
// matching the Missions actions. Authenticated callers are unaffected
// (getAuthFromCookie is cache()d).
async function requireGoalAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

const GOALS_LIST_PATH = '/[locale]/(dashboard)/goals';

function revalidateGoalDetail(id: string) {
    revalidatePath(`/[locale]/(dashboard)/goals/${id}`, 'page');
}

export async function createGoalAction(input: CreateGoalInput) {
    await requireGoalAuth();
    const goal = await goalsAPI.create(input);
    revalidatePath(GOALS_LIST_PATH, 'page');
    return goal;
}

export async function updateGoalAction(id: string, input: UpdateGoalInput) {
    await requireGoalAuth();
    const goal = await goalsAPI.update(id, input);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function deleteGoalAction(id: string) {
    await requireGoalAuth();
    const result = await goalsAPI.remove(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    return result;
}

export async function activateGoalAction(id: string) {
    await requireGoalAuth();
    const goal = await goalsAPI.activate(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function pauseGoalAction(id: string) {
    await requireGoalAuth();
    const goal = await goalsAPI.pause(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function evaluateGoalNowAction(id: string) {
    await requireGoalAuth();
    const result = await goalsAPI.evaluateNow(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return result;
}
