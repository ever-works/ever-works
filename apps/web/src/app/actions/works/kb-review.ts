'use server';

import { revalidatePath } from 'next/cache';
import { kbAPI, type KbDocumentListResponse } from '@/lib/api/kb';
import type { ActionResult } from '@/app/actions/plugins';
import type { KbDocumentBodyDto, KbDocumentDto } from '@ever-works/contracts';

/**
 * Memory upgrades M8 — server actions behind the KB **review queue**.
 *
 * The M7 backend lands every agent-authored / consolidation-synthesized
 * document as `reviewState='proposed'` and excludes it from context
 * injection at all three retrieval paths. Until this queue shipped those
 * endpoints had ZERO web callers, which made the circuit breaker a
 * discard: captured learning was never routed anywhere a human could see
 * it. These actions are the missing half.
 *
 * All four review actions are thin wrappers over endpoints that already
 * existed (`/accept`, `/archive`, `/decision-status`) — nothing new is
 * introduced on the API surface here. Each revalidates the KB index and
 * the review route so the server-rendered tree + queue reflect the new
 * state without a hard reload.
 */

function kbPaths(workId: string): string[] {
    return [`/works/${workId}/kb`, `/works/${workId}/kb/review`];
}

function revalidateKb(workId: string, docPath?: string): void {
    for (const path of kbPaths(workId)) revalidatePath(path);
    if (docPath) revalidatePath(`/works/${workId}/kb/${docPath}`);
}

function toMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * List the documents awaiting review for a Work — the queue's data
 * source. Uses the existing `GET /works/:id/kb/documents` list with the
 * additive `reviewState=proposed` filter (owner-scoped server-side via
 * `ensureCanView`), so no bespoke endpoint was needed.
 */
export async function listProposedKbDocumentsAction(
    workId: string,
    opts: { limit?: number } = {},
): Promise<ActionResult<KbDocumentListResponse>> {
    try {
        const data = await kbAPI.listDocuments(workId, {
            reviewState: 'proposed',
            limit: opts.limit ?? 100,
        });
        return { success: true, data };
    } catch (error) {
        console.error('[kb-review] failed to list proposed KB documents:', error);
        return { success: false, error: toMessage(error, 'Failed to load the review queue') };
    }
}

/**
 * Fetch one document's body so the queue can show a real content
 * preview. Deliberately lazy (per-row, on expand) — the list endpoint is
 * metadata-only and fetching every body up front would be a needless
 * fan-out on a queue that is usually skimmed, not read end to end.
 */
export async function getKbDocumentBodyAction(
    workId: string,
    docId: string,
): Promise<ActionResult<KbDocumentBodyDto>> {
    try {
        const data = await kbAPI.getDocument(workId, docId);
        return { success: true, data };
    } catch (error) {
        console.error('[kb-review] failed to load KB document body:', error);
        return { success: false, error: toMessage(error, 'Failed to load the document') };
    }
}

/** Accept — the document starts feeding agent context. Idempotent. */
export async function acceptKbDocumentAction(args: {
    workId: string;
    docId: string;
    path?: string;
}): Promise<ActionResult<KbDocumentDto>> {
    try {
        const doc = await kbAPI.acceptDocument(args.workId, args.docId);
        revalidateKb(args.workId, args.path);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-review] failed to accept KB document:', error);
        return { success: false, error: toMessage(error, 'Failed to accept the document') };
    }
}

/** Archive — status flip, never a physical delete. Idempotent. */
export async function archiveKbDocumentAction(args: {
    workId: string;
    docId: string;
    path?: string;
}): Promise<ActionResult<KbDocumentDto>> {
    try {
        const doc = await kbAPI.archiveDocument(args.workId, args.docId);
        revalidateKb(args.workId, args.path);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-review] failed to archive KB document:', error);
        return { success: false, error: toMessage(error, 'Failed to archive the document') };
    }
}

/**
 * Supersede — pick the survivor. Reuses the M4 decision status machine:
 * `superseded` with `supersededByDocId` writes the chain link on BOTH
 * documents, so the demoted decision keeps rendering as
 * "historical — replaced by kb:decision/<slug>" in agent context instead
 * of vanishing.
 *
 * Only meaningful for `class=decision` documents; the API returns 400 for
 * anything else and the UI hides the action accordingly.
 */
export async function supersedeKbDecisionAction(args: {
    workId: string;
    docId: string;
    supersededByDocId: string;
    rationale?: string;
    path?: string;
}): Promise<ActionResult<KbDocumentDto>> {
    try {
        const doc = await kbAPI.transitionDecisionStatus(args.workId, args.docId, {
            status: 'superseded',
            supersededByDocId: args.supersededByDocId,
            ...(args.rationale ? { rationale: args.rationale } : {}),
        });
        revalidateKb(args.workId, args.path);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-review] failed to supersede KB decision:', error);
        return { success: false, error: toMessage(error, 'Failed to supersede the decision') };
    }
}

/**
 * Candidate survivors for the supersede picker: the Work's accepted
 * decision documents, minus the one being superseded.
 */
export async function listSupersedeCandidatesAction(
    workId: string,
    excludeDocId: string,
): Promise<ActionResult<KbDocumentDto[]>> {
    try {
        const { items } = await kbAPI.listDocuments(workId, { class: 'decision', limit: 100 });
        const candidates = items.filter(
            (doc) => doc.id !== excludeDocId && doc.decision?.status === 'accepted',
        );
        return { success: true, data: candidates };
    } catch (error) {
        console.error('[kb-review] failed to list supersede candidates:', error);
        return { success: false, error: toMessage(error, 'Failed to load decisions') };
    }
}
