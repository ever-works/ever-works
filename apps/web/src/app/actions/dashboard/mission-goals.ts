'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { missionsAPI, type MissionGoalLinkDto } from '@/lib/api/missions';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Goals & Metrics PR-8 — server actions for the Mission ↔ Goal link
 * surface (`mission_goals`, spec FR-11). Split out of `missions.ts`
 * the same way `mission-works.ts` was, so this wave stays additive;
 * mirrors its auth-guard + revalidate pattern exactly.
 *
 * Invariant I-4 surfaced to the UI copy: Goal state never feeds back
 * into Mission status — a Mission is completed only by an explicit
 * human action, never because an attached Goal was achieved or missed.
 */

// Security: defense-in-depth auth guard at the web layer (same as
// requireMissionAuth in ./missions.ts — not exported there since
// 'use server' files may only export async server actions).
async function requireMissionAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

// Route patterns, not rendered paths: the locale is unknown here, so
// interpolating a real ID next to an unresolved `[locale]` matches
// nothing. Passing the whole filesystem pattern with 'page' revalidates
// the route across every locale — same convention as ADMIN_PAGE_PATTERN
// in ../admin/tenant-runtime-allowlist.ts.
const MISSION_DETAIL_PATTERN = '/[locale]/(dashboard)/missions/[id]';
const GOAL_DETAIL_PATTERN = '/[locale]/(dashboard)/goals/[id]';

/** `GET /me/missions/:id/goals` — the Goals attached to this Mission. */
export async function listMissionGoalsAction(missionId: string): Promise<MissionGoalLinkDto[]> {
    await requireMissionAuth();
    return missionsAPI.listGoals(missionId);
}

/**
 * `POST /me/missions/:id/goals` — attach a Goal, then re-read the list.
 *
 * The API returns only the affected edge, but linking with
 * `isPrimary: true` demotes the Mission's existing primary server-side
 * (one-primary-per-Mission, FR-11). Re-reading is how the panel picks
 * that up without duplicating the demote rule client-side.
 */
export async function linkGoalToMissionAction(
    missionId: string,
    input: { goalId: string; isPrimary?: boolean },
): Promise<MissionGoalLinkDto[]> {
    await requireMissionAuth();
    await missionsAPI.linkGoal(missionId, input);
    const links = await missionsAPI.listGoals(missionId);
    // Mission detail renders the "Goals" panel; the Goal detail page
    // may surface the reverse link once that view grows one.
    revalidatePath(MISSION_DETAIL_PATTERN, 'page');
    revalidatePath(GOAL_DETAIL_PATTERN, 'page');
    return links;
}

/**
 * `DELETE /me/missions/:id/goals/:goalId` — detach a Goal from a
 * Mission.
 *
 * Removes the `mission_goals` edge ONLY. The Goal itself survives on
 * the /goals surface and on any other Mission it is attached to —
 * deleting the Goal proper is `deleteGoalAction` on the Goal detail
 * page. Unlike the attach path there is no server-side ripple to pick
 * up (detaching a primary Goal does not promote another), so the
 * caller can drop the row locally instead of re-reading the list.
 */
export async function unlinkGoalFromMissionAction(
    missionId: string,
    goalId: string,
): Promise<{ deleted: true }> {
    await requireMissionAuth();
    const result = await missionsAPI.unlinkGoal(missionId, goalId);
    revalidatePath(MISSION_DETAIL_PATTERN, 'page');
    revalidatePath(GOAL_DETAIL_PATTERN, 'page');
    return result;
}
