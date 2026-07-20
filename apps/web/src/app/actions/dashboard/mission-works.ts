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

function revalidateMissionWorkSurfaces(missionId: string, workId: string) {
    // Mission detail renders the "Attached Works" panel; the Work
    // Overview tab renders the reverse "Missions" panel.
    revalidatePath(`/[locale]/(dashboard)/missions/${missionId}`, 'page');
    revalidatePath(`/[locale]/(dashboard)/works/${workId}`, 'page');
}

export async function attachWorkToMissionAction(
    missionId: string,
    input: { workId: string; relation: MissionWorkRelation },
) {
    await requireMissionAuth();
    const relations = await missionsAPI.attachWork(missionId, input);
    revalidateMissionWorkSurfaces(missionId, input.workId);
    return relations;
}

export async function detachWorkFromMissionAction(
    missionId: string,
    workId: string,
    relation: MissionWorkRelation,
) {
    await requireMissionAuth();
    const result = await missionsAPI.detachWork(missionId, workId, relation);
    revalidateMissionWorkSurfaces(missionId, workId);
    return result;
}
