'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { missionsAPI, type CreateMissionInput, type UpdateMissionInput } from '@/lib/api/missions';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

// Security: defense-in-depth auth guard at the web layer. All Mission server
// actions forward straight to the JWT-protected API; this rejects unauthenticated
// callers before any request is issued, matching the pattern in comparisons.ts /
// items.ts. Authenticated callers are unaffected (getAuthFromCookie is cache()d).
async function requireMissionAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

// Phase 6 PR Q — the `/missions` catalog page and (Phase 6 PR S)
// the dashboard preview block both want their cache invalidated
// whenever a Mission is created / mutated / lifecycled.
const MISSION_REVALIDATE_PATHS = ['/[locale]/(dashboard)/(home)', '/[locale]/(dashboard)/missions'];
function revalidateMissionSurfaces() {
    for (const p of MISSION_REVALIDATE_PATHS) {
        revalidatePath(p, 'page');
    }
}

export async function listMissionsAction() {
    await requireMissionAuth();
    return missionsAPI.list();
}

export async function createMissionAction(input: CreateMissionInput) {
    await requireMissionAuth();
    const mission = await missionsAPI.create(input);
    revalidateMissionSurfaces();
    return mission;
}

export async function updateMissionAction(id: string, input: UpdateMissionInput) {
    await requireMissionAuth();
    const mission = await missionsAPI.update(id, input);
    revalidateMissionSurfaces();
    // Also bust the per-Mission detail-page path once Phase 6 PR R
    // adds it.
    revalidatePath(`/[locale]/(dashboard)/missions/${id}`, 'page');
    return mission;
}

export async function deleteMissionAction(id: string) {
    await requireMissionAuth();
    const result = await missionsAPI.remove(id);
    revalidateMissionSurfaces();
    return result;
}

export async function pauseMissionAction(id: string) {
    await requireMissionAuth();
    const mission = await missionsAPI.pause(id);
    revalidateMissionSurfaces();
    return mission;
}

export async function resumeMissionAction(id: string) {
    await requireMissionAuth();
    const mission = await missionsAPI.resume(id);
    revalidateMissionSurfaces();
    return mission;
}

export async function completeMissionAction(id: string) {
    await requireMissionAuth();
    const mission = await missionsAPI.complete(id);
    revalidateMissionSurfaces();
    return mission;
}

export async function runMissionNowAction(id: string) {
    await requireMissionAuth();
    const result = await missionsAPI.runNow(id);
    // Run-now spawns Ideas; bust the Ideas catalog too so the
    // user sees the new rows after navigating back.
    revalidatePath('/[locale]/(dashboard)/ideas', 'page');
    revalidateMissionSurfaces();
    return result;
}

export async function cloneMissionAction(id: string, title?: string) {
    await requireMissionAuth();
    const result = await missionsAPI.clone(id, title);
    revalidateMissionSurfaces();
    return result;
}

// Attachment actions — used by the PromptComposer-driven create flow
// on /new (Mission template inline-create path) to wire uploads into
// the newly created Mission, and by future Mission detail pages.

export async function attachUploadToMissionAction(missionId: string, uploadId: string) {
    await requireMissionAuth();
    const row = await missionsAPI.addAttachment(missionId, uploadId);
    revalidatePath(`/[locale]/(dashboard)/missions/${missionId}`, 'page');
    return row;
}

export async function detachMissionAttachmentAction(missionId: string, attachmentId: string) {
    await requireMissionAuth();
    const result = await missionsAPI.removeAttachment(missionId, attachmentId);
    revalidatePath(`/[locale]/(dashboard)/missions/${missionId}`, 'page');
    return result;
}
