'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    agentApprovalsAPI,
    type AgentActionProposal,
    type ListAgentApprovalsQuery,
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

export async function listPendingApprovalsAction(
    query: ListAgentApprovalsQuery = {},
): Promise<AgentActionProposal[]> {
    await requireApprovalAuth();
    const res = await agentApprovalsAPI.list({ status: 'pending', ...query });
    return res.data;
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
 * Bulk-approve every supplied proposal id. There's no bulk API
 * endpoint (keeping the decision surface auditable one row at a time),
 * so this fans out to the single-row approve endpoint and reports
 * per-id success/failure. Cache is busted once at the end.
 */
export async function approveAllProposalsAction(
    ids: string[],
): Promise<{ approved: string[]; failed: string[] }> {
    await requireApprovalAuth();
    const approved: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
        try {
            await agentApprovalsAPI.approve(id);
            approved.push(id);
        } catch {
            // A concurrently-decided proposal 409s — record it as failed
            // and keep going so one stale row doesn't abort the batch.
            failed.push(id);
        }
    }
    revalidateApprovalSurfaces();
    return { approved, failed };
}
