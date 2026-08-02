'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { missionsAPI, type MissionWorkRelation } from '@/lib/api/missions';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * PR-2 (domain-model evolution) — server actions for the explicit
 * Mission↔Work M:N relation surface (`mission_works`). Split out of
 * `missions.ts` so the attach/detach wave stays additive; mirrors its
 * auth-guard + revalidate pattern exactly.
 *
 * Invariants surfaced to the UI copy: Missions never own Works (I-7)
 * and detaching / deleting a Mission never touches the Work (I-6).
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
const WORK_DETAIL_PATTERN = '/[locale]/(dashboard)/works/[id]';

function revalidateMissionWorkSurfaces() {
    // Mission detail renders the "Attached Works" panel; the Work
    // Overview tab renders the reverse "Missions" panel.
    revalidatePath(MISSION_DETAIL_PATTERN, 'page');
    revalidatePath(WORK_DETAIL_PATTERN, 'page');
}

export async function attachWorkToMissionAction(
    missionId: string,
    input: { workId: string; relation: MissionWorkRelation },
) {
    await requireMissionAuth();
    const relations = await missionsAPI.attachWork(missionId, input);
    revalidateMissionWorkSurfaces();
    return relations;
}

export async function detachWorkFromMissionAction(
    missionId: string,
    workId: string,
    relation: MissionWorkRelation,
) {
    await requireMissionAuth();
    const result = await missionsAPI.detachWork(missionId, workId, relation);
    revalidateMissionWorkSurfaces();
    return result;
}
