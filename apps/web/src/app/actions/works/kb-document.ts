'use server';

import { revalidatePath } from 'next/cache';
import { kbAPI } from '@/lib/api/kb';
import type { ActionResult } from '@/app/actions/plugins';
import type { KbDocumentBodyDto, UpdateKbDocumentInput } from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 5 — server action that the client-side
 * `KbEditor` calls when the operator clicks "Save".
 *
 * The Next.js `KbEditor` is a client component, so it can't reach the
 * server-only `kbAPI.updateDocument` helper directly — bouncing through
 * a server action keeps the JWT cookie + API base URL handling on the
 * server side and gives the client a clean `ActionResult` envelope to
 * branch on. Spec §14 "Manual save" — autosave arrives in row 6.
 *
 * `revalidatePath` busts the cache for both the index page and the
 * nested detail route so the tree panel + viewer reflect the new
 * title / body / status without a full reload.
 */
export async function updateKbDocumentAction(args: {
    workId: string;
    docId: string;
    body: UpdateKbDocumentInput;
}): Promise<ActionResult<KbDocumentBodyDto>> {
    const { workId, docId, body } = args;
    try {
        const doc = await kbAPI.updateDocument(workId, docId, body);
        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${doc.path}`);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-editor] failed to update KB document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save document',
        };
    }
}
