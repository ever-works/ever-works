'use server';

import { revalidatePath } from 'next/cache';
import { kbAPI } from '@/lib/api/kb';
import type { ActionResult } from '@/app/actions/plugins';
import type { KbDocumentDto, KbLockMode } from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 14 — lock/unlock server actions invoked by the
 * client-side `KbLockControls`.
 *
 * Both helpers thread the JWT cookie + API base URL through the same
 * `kbAPI` server-only fetch helpers used by row 5's
 * `updateKbDocumentAction`. The `ActionResult` envelope lets the client
 * branch on success without re-throwing the inner error message —
 * matching the existing pattern.
 *
 * Both actions `revalidatePath` the KB index + the nested document
 * route so the server-rendered tree panel + the editor's full-lock
 * branch (`<KbDocumentView>` vs `<KbEditor>`) re-render after the API
 * round-trip lands.
 */
export async function lockKbDocumentAction(args: {
    workId: string;
    docId: string;
    path: string;
    mode: KbLockMode;
}): Promise<ActionResult<KbDocumentDto>> {
    const { workId, docId, path, mode } = args;
    try {
        const doc = await kbAPI.lockDocument(workId, docId, mode);
        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${path}`);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-lock] failed to lock KB document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to lock document',
        };
    }
}

export async function unlockKbDocumentAction(args: {
    workId: string;
    docId: string;
    path: string;
}): Promise<ActionResult<KbDocumentDto>> {
    const { workId, docId, path } = args;
    try {
        const doc = await kbAPI.unlockDocument(workId, docId);
        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${path}`);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-lock] failed to unlock KB document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to unlock document',
        };
    }
}
