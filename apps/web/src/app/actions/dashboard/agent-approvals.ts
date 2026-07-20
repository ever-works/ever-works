'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    agentApprovalsAPI,
    type AgentActionProposal,
    type ApproveAllAgentApprovalsResult,
} from '@/lib/api/agent-approvals';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

// Security: defense-in-depth auth guard at the web layer. All approval
// server actions forward to the JWT-protected API; this rejects
// unauthenticated callers before any request is issued, matching the
// pattern in missions.ts / comparisons.ts.
async function requireApprovalAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

// The approval queue surfaces on the dashboard home; bust its cache
// whenever a decision lands so the block reflects the new state.
function revalidateApprovalSurfaces() {
    revalidatePath('/[locale]/(dashboard)/(home)', 'page');
}

export async function approveProposalAction(id: string): Promise<AgentActionProposal> {
    await requireApprovalAuth();
    const row = await agentApprovalsAPI.approve(id);
    revalidateApprovalSurfaces();
    return row;
}

export async function rejectProposalAction(id: string): Promise<AgentActionProposal> {
    await requireApprovalAuth();
    const row = await agentApprovalsAPI.reject(id);
    revalidateApprovalSurfaces();
    return row;
}

/**
 * Bulk-approve pending proposals via the single `approve-all` API
 * endpoint — ONE write (one throttle hit) no matter how many rows are
 * queued. `ids` optionally narrows the batch to what the caller sees;
 * concurrently-decided rows are skipped server-side and reported in
 * the returned counts. Cache is busted once at the end.
 */
export async function approveAllProposalsAction(
    ids?: string[],
): Promise<ApproveAllAgentApprovalsResult> {
    await requireApprovalAuth();
    const result = await agentApprovalsAPI.approveAll(ids);
    revalidateApprovalSurfaces();
    return result;
}
