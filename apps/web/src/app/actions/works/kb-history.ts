'use server';

import { revalidatePath } from 'next/cache';
import { kbAPI } from '@/lib/api/kb';
import type { ActionResult } from '@/app/actions/plugins';
import type { KbDocumentBodyDto, KbDocumentHistoryResult } from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 18c — KB history server actions.
 *
 * The dialog is client-rendered and needs a server-action bridge to
 * reach `kbAPI` (which is `'server-only'`). Same envelope pattern as
 * row 5's `updateKbDocumentAction` and row 14's `lockKbDocumentAction`.
 *
 * - `getKbDocumentHistoryAction` — read-only list of commits touching
 *   the doc. Returns `{ items: [] }` while the row-18b git-log impl
 *   is pending; the dialog renders the empty state.
 * - `restoreKbDocumentAction` — POSTs to the existing
 *   `/restore { commitSha }` endpoint and revalidates the doc route +
 *   KB index so the tree + editor reflect the restored body.
 */
export async function getKbDocumentHistoryAction(args: {
    workId: string;
    docId: string;
    limit?: number;
}): Promise<ActionResult<KbDocumentHistoryResult>> {
    try {
        const data = await kbAPI.getDocumentHistory(args.workId, args.docId, {
            limit: args.limit,
        });
        return { success: true, data };
    } catch (error) {
        console.error('[kb-history] failed to fetch history:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch history',
        };
    }
}

export async function restoreKbDocumentAction(args: {
    workId: string;
    docId: string;
    path: string;
    commitSha: string;
}): Promise<ActionResult<KbDocumentBodyDto>> {
    const { workId, docId, path, commitSha } = args;
    try {
        const data = await kbAPI.restoreDocument(workId, docId, commitSha);
        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${path}`);
        return { success: true, data };
    } catch (error) {
        console.error('[kb-history] failed to restore document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to restore document',
        };
    }
}
