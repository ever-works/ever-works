'use server';

import { redirect } from 'next/navigation';
import type {
    FleetCheckoutChangesReply,
    FleetCheckoutPullRequestFacts,
    FleetOpenPullRequestRequest,
    FleetOpenPullRequestResponse,
    FleetPullRequestDraft,
    FleetSessionActionId,
    FleetSessionActionLedgerResponse,
    FleetSessionActionSendResponse,
    FleetSessionActionsResponse,
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

/** The seven actions of a session, offered or not and why, with their rendered prompts (spec FR-12 … FR-15). */
export async function getSessionActionsAction(
    sessionId: string,
): Promise<SessionGitActionResult<FleetSessionActionsResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.actions(sessionId) };
    } catch (error) {
        return refusal(error);
    }
}

/** Type an action's prompt into the session (spec FR-14). */
export async function sendSessionActionAction(
    sessionId: string,
    actionId: FleetSessionActionId,
    prompt: string,
): Promise<SessionGitActionResult<FleetSessionActionSendResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.sendAction(sessionId, { actionId, prompt }) };
    } catch (error) {
        return refusal(error);
    }
}

/** The actions sent so far (spec FR-22). */
export async function getSessionActionsLedgerAction(
    sessionId: string,
): Promise<SessionGitActionResult<FleetSessionActionLedgerResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.ledger(sessionId) };
    } catch (error) {
        return refusal(error);
    }
}

/** Send again an action that was not delivered (spec FR-24). */
export async function resendSessionActionAction(
    sessionId: string,
    ledgerId: string,
    prompt?: string,
): Promise<SessionGitActionResult<FleetSessionActionSendResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.resendAction(sessionId, ledgerId, prompt) };
    } catch (error) {
        return refusal(error);
    }
}

/** Open (or update) the pull request of a checkout's branch, through the GitHub App (spec FR-16 … FR-18). */
export async function openCheckoutPullRequestAction(
    checkoutId: string,
    body: FleetOpenPullRequestRequest,
): Promise<SessionGitActionResult<FleetOpenPullRequestResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.openPullRequest(checkoutId, body) };
    } catch (error) {
        return refusal(error);
    }
}

/** What the pull-request dialog is prefilled with (spec §5.4). */
export async function getPullRequestDraftAction(
    checkoutId: string,
): Promise<SessionGitActionResult<FleetPullRequestDraft>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetSessionGitAPI.pullRequestDraft(checkoutId) };
    } catch (error) {
        return refusal(error);
    }
}
