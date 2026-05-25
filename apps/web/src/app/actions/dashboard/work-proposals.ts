'use server';

import { revalidatePath } from 'next/cache';
import {
    workProposalsAPI,
    type CreateIdeaInput,
    type WorkProposalStatus,
} from '@/lib/api/work-proposals';

// The dashboard preview block (home) and the dedicated /ideas page
// (Phase 5 PR N) both want their cache invalidated when an Idea is
// created / dismissed / built / accepted. Defining the paths in
// one place keeps each action's revalidate list a single source
// of truth.
const IDEA_REVALIDATE_PATHS = ['/[locale]/(dashboard)/(home)', '/[locale]/(dashboard)/ideas'];
function revalidateIdeaSurfaces() {
    for (const p of IDEA_REVALIDATE_PATHS) {
        revalidatePath(p, 'page');
    }
}

export async function refreshProposalsAction() {
    const result = await workProposalsAPI.refresh();
    revalidateIdeaSurfaces();
    return result;
}

export async function dismissProposalAction(proposalId: string) {
    await workProposalsAPI.dismiss(proposalId);
    revalidateIdeaSurfaces();
    return { ok: true };
}

export async function acceptProposalAction(proposalId: string, workId: string) {
    const result = await workProposalsAPI.accept(proposalId, workId);
    revalidateIdeaSurfaces();
    return result;
}

export async function getProposalsStatusAction() {
    return workProposalsAPI.status();
}

export async function listProposalsAction(
    statuses: WorkProposalStatus[] = ['pending'],
    opts: { missionId?: string } = {},
) {
    return workProposalsAPI.list(statuses, opts);
}

// Phase 5 PR N — quick-add Idea from the `+ Add` button on the
// /ideas page. Returns the freshly-created Idea so the client can
// prepend it to its local list without round-tripping the whole
// catalog.
export async function createIdeaAction(input: CreateIdeaInput) {
    const idea = await workProposalsAPI.createUserManual(input);
    revalidateIdeaSurfaces();
    return idea;
}

// Phase 5 PR N — queue an Idea for build from the IdeaCard's
// Build CTA. Returns the goal id so the future Mission detail
// page can pivot to it for live-run details.
export async function buildIdeaAction(proposalId: string) {
    const result = await workProposalsAPI.build(proposalId);
    revalidateIdeaSurfaces();
    return result;
}
