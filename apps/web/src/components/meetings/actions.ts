'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { meetingsAPI, type CreateMeetingInput, type UpdateMeetingInput } from '@/lib/api/meetings';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Meetings — server actions backing the Meetings UI. Each one forwards
 * to the JWT-protected `/api/meetings` surface and busts the relevant
 * page caches, mirroring `components/goals/actions.ts`. Lives alongside
 * the Meetings components so the whole surface ships in one directory.
 */

// Security: defense-in-depth auth guard at the web layer. Every Meeting
// server action forwards straight to the JWT-protected API; this rejects
// unauthenticated callers before any request is issued, matching the
// Goals actions. Authenticated callers are unaffected
// (getAuthFromCookie is cache()d).
async function requireMeetingAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

const MEETINGS_LIST_PATH = '/[locale]/(dashboard)/meetings';

function revalidateMeetingDetail(id: string) {
    revalidatePath(`/[locale]/(dashboard)/meetings/${id}`, 'page');
}

export async function createMeetingAction(input: CreateMeetingInput) {
    await requireMeetingAuth();
    const meeting = await meetingsAPI.create(input);
    revalidatePath(MEETINGS_LIST_PATH, 'page');
    return meeting;
}

export async function updateMeetingAction(id: string, input: UpdateMeetingInput) {
    await requireMeetingAuth();
    const meeting = await meetingsAPI.update(id, input);
    revalidatePath(MEETINGS_LIST_PATH, 'page');
    revalidateMeetingDetail(id);
    return meeting;
}

export async function deleteMeetingAction(id: string) {
    await requireMeetingAuth();
    await meetingsAPI.remove(id);
    revalidatePath(MEETINGS_LIST_PATH, 'page');
    return { deleted: true as const };
}

/**
 * Attach (or replace) the transcript. The API stores it and then runs
 * the BEST-EFFORT fan-out (AI summary → Memory observation → ingest
 * envelope), so the result's `summary` may be absent and both booleans
 * false on a stack with no AI provider — the caller surfaces that
 * honestly instead of pretending a summary was produced.
 */
export async function ingestMeetingTranscriptAction(id: string, transcriptText: string) {
    await requireMeetingAuth();
    const result = await meetingsAPI.ingestTranscript(id, transcriptText);
    revalidatePath(MEETINGS_LIST_PATH, 'page');
    revalidateMeetingDetail(id);
    return result;
}
