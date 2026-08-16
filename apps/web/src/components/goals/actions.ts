'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    goalsAPI,
    type CreateGoalInput,
    type GoalDoDCriterion,
    type PatchGoalDodCriterionInput,
    type UpdateGoalInput,
    type UpdateGoalLimitsInput,
} from '@/lib/api/goals';
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

// ── Autonomy layer — Definition of Done, limits, loop control ─────
//
// Every action below busts BOTH the detail page and the list: a loop
// state change or a DoD tick moves the card's progress chip too, and a
// stale catalog after an operator action is the exact thing that makes
// a control surface feel broken.

export async function updateGoalLimitsAction(id: string, input: UpdateGoalLimitsInput) {
    await requireGoalAuth();
    const goal = await goalsAPI.updateLimits(id, input);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function setGoalDodAction(id: string, criteria: GoalDoDCriterion[] | null) {
    await requireGoalAuth();
    const goal = await goalsAPI.setDod(id, criteria);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function patchGoalDodCriterionAction(
    id: string,
    criterionId: string,
    input: PatchGoalDodCriterionInput,
) {
    await requireGoalAuth();
    const goal = await goalsAPI.patchDodCriterion(id, criterionId, input);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function approveGoalDodAction(id: string, criterionIds?: string[]) {
    await requireGoalAuth();
    const goal = await goalsAPI.approveDod(id, criterionIds);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function goalLoopAction(id: string, action: 'start' | 'pause' | 'resume' | 'cancel') {
    await requireGoalAuth();
    const goal = await goalsAPI.loopAction(id, action);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function restartGoalSessionAction(id: string) {
    await requireGoalAuth();
    const result = await goalsAPI.restartSession(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return result;
}

export async function advanceGoalAction(id: string) {
    await requireGoalAuth();
    const result = await goalsAPI.advance(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return result;
}

export async function nudgeGoalAction(id: string, message: string) {
    await requireGoalAuth();
    const result = await goalsAPI.nudge(id, message);
    revalidateGoalDetail(id);
    return result;
}

export async function archiveGoalAction(id: string) {
    await requireGoalAuth();
    const goal = await goalsAPI.archive(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}

export async function unarchiveGoalAction(id: string) {
    await requireGoalAuth();
    const goal = await goalsAPI.unarchive(id);
    revalidatePath(GOALS_LIST_PATH, 'page');
    revalidateGoalDetail(id);
    return goal;
}
