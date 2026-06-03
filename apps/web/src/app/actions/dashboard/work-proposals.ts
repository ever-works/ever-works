'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    workProposalsAPI,
    type CreateIdeaInput,
    type WorkProposalStatus,
} from '@/lib/api/work-proposals';
// Security: server actions must independently verify authentication at the
// Next.js layer before proxying to backend mutation/read endpoints. Server
// actions are reachable as POST endpoints via the `Next-Action` header, so we
// cannot rely on UI gating alone. Mirrors works.ts / taxonomy.ts / work-schedule.ts.
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

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
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const result = await workProposalsAPI.refresh();
    revalidateIdeaSurfaces();
    return result;
}

export async function dismissProposalAction(proposalId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    await workProposalsAPI.dismiss(proposalId);
    revalidateIdeaSurfaces();
    return { ok: true };
}

export async function acceptProposalAction(proposalId: string, workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const result = await workProposalsAPI.accept(proposalId, workId);
    revalidateIdeaSurfaces();
    return result;
}

export async function getProposalsStatusAction() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return workProposalsAPI.status();
}

export async function listProposalsAction(
    statuses: WorkProposalStatus[] = ['pending'],
    opts: { missionId?: string } = {},
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    return workProposalsAPI.list(statuses, opts);
}

// Phase 5 PR N — quick-add Idea from the `+ Add` button on the
// /ideas page. Returns the freshly-created Idea so the client can
// prepend it to its local list without round-tripping the whole
// catalog.
export async function createIdeaAction(input: CreateIdeaInput) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const idea = await workProposalsAPI.createUserManual(input);
    revalidateIdeaSurfaces();
    return idea;
}

// Phase 5 PR N — queue an Idea for build from the IdeaCard's
// Build CTA. Returns the goal id so the future Mission detail
// page can pivot to it for live-run details.
export async function buildIdeaAction(proposalId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const result = await workProposalsAPI.build(proposalId);
    revalidateIdeaSurfaces();
    return result;
}

// Attachment actions — used by the PromptComposer-driven flow on
// /new (Idea chip) and the standalone /ideas quick-add. Lets the
// caller wire uploads to a freshly-created Idea once we have its id.

export async function attachUploadToIdeaAction(ideaId: string, uploadId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const row = await workProposalsAPI.addAttachment(ideaId, uploadId);
    revalidatePath(`/[locale]/(dashboard)/ideas/${ideaId}`, 'page');
    return row;
}

export async function detachIdeaAttachmentAction(ideaId: string, attachmentId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const result = await workProposalsAPI.removeAttachment(ideaId, attachmentId);
    revalidatePath(`/[locale]/(dashboard)/ideas/${ideaId}`, 'page');
    return result;
}
