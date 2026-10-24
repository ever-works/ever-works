'use server';

import { redirect } from 'next/navigation';
import type {
    FleetCheckoutView,
    FleetGitIdentity,
    FleetGitIdentitySetResult,
    FleetTaskHandoffOptions,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetCheckoutsAPI } from '@/lib/api/fleet-checkouts';
import { fleetTaskHandoffAPI } from '@/lib/api/fleet-task-handoff';

/**
 * Tasks on computers (FL-15 P1) — Server Actions behind the **Fix with an
 * agent on this computer** dialog: its options, and the checkout it waits on
 * while a new worktree or a fresh clone is made. Same posture as
 * `app/actions/fleet-checkouts.ts`: the session is re-verified at the
 * boundary and the answer is a discriminated union carrying the CONTRACTS §8
 * `code` and the API's `hint` — never a thrown message, which production
 * redacts. The session start itself goes through FL-04's BFF route with
 * `taskId` (`sessionsClient.start`).
 */

export type HandoffActionResult<T> =
    | { success: true; data: T }
    | { success: false; code: string | null; hint: string | null; details: Record<string, unknown> | null };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function refusal(error: unknown): HandoffActionResult<never> {
    if (error instanceof ApiResponseError) {
        const envelope = (error.details as { error?: { hint?: unknown; details?: unknown } } | undefined)
            ?.error;
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

/** What the dialog offers for a Task (`agentId` re-judges the computers for that Agent). */
export async function getTaskHandoffOptionsAction(
    taskId: string,
    agentId?: string | null,
): Promise<HandoffActionResult<FleetTaskHandoffOptions>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetTaskHandoffAPI.options(taskId, agentId ?? null) };
    } catch (error) {
        return refusal(error);
    }
}

/** One checkout, re-read while the dialog waits for it to become ready. */
export async function getHandoffCheckoutAction(id: string): Promise<HandoffActionResult<FleetCheckoutView>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.get(id) };
    } catch (error) {
        return refusal(error);
    }
}

/** FL-15 P2: a computer's git identity (the Settings card and the dialog's line). */
export async function getGitIdentityAction(
    nodeId: string,
    fresh = false,
): Promise<HandoffActionResult<FleetGitIdentity>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetTaskHandoffAPI.gitIdentity(nodeId, fresh) };
    } catch (error) {
        return refusal(error);
    }
}

/**
 * FL-15 P2: **Use my Ever Works identity**. Without `confirm` the answer is
 * `code: 'confirmation_required'` with `details` = `{ summary, name, email,
 * emailSource }` — what the confirmation shows.
 */
export async function setGitIdentityAction(
    nodeId: string,
    confirm: boolean,
): Promise<HandoffActionResult<FleetGitIdentitySetResult>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetTaskHandoffAPI.setGitIdentity(nodeId, confirm) };
    } catch (error) {
        return refusal(error);
    }
}
