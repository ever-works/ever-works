'use server';

import { revalidatePath } from 'next/cache';
import {
    missionsAPI,
    type CreateMissionInput,
    type UpdateMissionInput,
} from '@/lib/api/missions';

// Phase 6 PR Q — the `/missions` catalog page and (Phase 6 PR S)
// the dashboard preview block both want their cache invalidated
// whenever a Mission is created / mutated / lifecycled.
const MISSION_REVALIDATE_PATHS = [
    '/[locale]/(dashboard)/(home)',
    '/[locale]/(dashboard)/missions',
];
function revalidateMissionSurfaces() {
    for (const p of MISSION_REVALIDATE_PATHS) {
        revalidatePath(p, 'page');
    }
}

export async function listMissionsAction() {
    return missionsAPI.list();
}

export async function createMissionAction(input: CreateMissionInput) {
    const mission = await missionsAPI.create(input);
    revalidateMissionSurfaces();
    return mission;
}

export async function updateMissionAction(id: string, input: UpdateMissionInput) {
    const mission = await missionsAPI.update(id, input);
    revalidateMissionSurfaces();
    // Also bust the per-Mission detail-page path once Phase 6 PR R
    // adds it.
    revalidatePath(`/[locale]/(dashboard)/missions/${id}`, 'page');
    return mission;
}

export async function deleteMissionAction(id: string) {
    const result = await missionsAPI.remove(id);
    revalidateMissionSurfaces();
    return result;
}

export async function pauseMissionAction(id: string) {
    const mission = await missionsAPI.pause(id);
    revalidateMissionSurfaces();
    return mission;
}

export async function resumeMissionAction(id: string) {
    const mission = await missionsAPI.resume(id);
    revalidateMissionSurfaces();
    return mission;
}

export async function completeMissionAction(id: string) {
    const mission = await missionsAPI.complete(id);
    revalidateMissionSurfaces();
    return mission;
}

export async function runMissionNowAction(id: string) {
    const result = await missionsAPI.runNow(id);
    // Run-now spawns Ideas; bust the Ideas catalog too so the
    // user sees the new rows after navigating back.
    revalidatePath('/[locale]/(dashboard)/ideas', 'page');
    revalidateMissionSurfaces();
    return result;
}

export async function cloneMissionAction(id: string, title?: string) {
    const result = await missionsAPI.clone(id, title);
    revalidateMissionSurfaces();
    return result;
}
