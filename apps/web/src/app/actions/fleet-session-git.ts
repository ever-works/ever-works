'use server';

import { redirect } from 'next/navigation';
import type {
    FleetCheckoutChangesReply,
    FleetCheckoutPullRequestFacts,
    FleetSessionBranchProposal,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetSessionGitAPI, type FleetBranchProposalQuery } from '@/lib/api/fleet-session-git';

/**
 * Session git & actions (FL-06) — Server Actions over the session git routes.
 *
 * Same posture as `app/actions/fleet-checkouts.ts`: the session is re-verified
 * at the boundary (the API is the final guard) and the answer is a
 * discriminated union — never a thrown message, which production redacts. A
 * refusal carries the CONTRACTS §8 `code` (the client picks the
 * `fleet.errors.*` sentence by it) and the API's `hint` (shown under it).
 */

export type SessionGitActionResult<T> =
    | { success: true; data: T }
    | {
          success: false;
          code: string | null;
          hint: string | null;
          details: Record<string, unknown> | null;
      };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function refusal(error: unknown): SessionGitActionResult<never> {
    if (error instanceof ApiResponseError) {
        const envelope = (error.details as { error?: { hint?: unknown; details?: unknown } } | undefined)?.error;
        return {
            success: false,
            code: error.code ?? null,
            hint: typeof envelope?.hint === 'string' ? envelope.hint : null,
            details:
                envelope?.details && typeof envelope.details === 'object'
                    ? (envelope.details as Record<string, unknown>)
                    : null,
        };
    }
    return { success: false, code: null, hint: null, details: null };
}

/** The branch of a new session's worktree (spec FR-3 … FR-5): `<prefix>/<slug>`, never reused. */
export async function getSessionBranchProposalAction(
    input: FleetBranchProposalQuery,
): Promise<SessionGitActionResult<FleetSessionBranchProposal>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.branchProposal(input) };
    } catch (error) {
        return refusal(error);
    }
}

/** The uncommitted diff of a checkout (spec FR-9), read on the computer. */
export async function getCheckoutChangesAction(
    checkoutId: string,
    maxBytes?: number,
): Promise<SessionGitActionResult<FleetCheckoutChangesReply>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.changes(checkoutId, maxBytes) };
    } catch (error) {
        return refusal(error);
    }
}

/** The pull request beside a checkout's git line (spec FR-7), with `unknownSince` when GitHub is unreachable. */
export async function getCheckoutPullRequestAction(
    checkoutId: string,
): Promise<SessionGitActionResult<FleetCheckoutPullRequestFacts>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.pullRequest(checkoutId) };
    } catch (error) {
        return refusal(error);
    }
}
