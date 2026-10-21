'use server';

import { redirect } from 'next/navigation';
import type {
    FleetCheckoutListResponse,
    FleetCheckoutOperationResponse,
    FleetCheckoutState,
    FleetCheckoutSyncOp,
    FleetCheckoutView,
    FleetNodeCheckoutsResponse,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetCheckoutsAPI } from '@/lib/api/fleet-checkouts';

/**
 * Checkouts on computers (FL-14) — Server Actions over `/api/fleet/checkouts*`.
 *
 * Same posture as `app/actions/settings/fleet.ts`: the session is re-verified
 * at the boundary (the API is the final guard) and the answer is a
 * discriminated union — never a thrown message, which production redacts.
 * A refusal carries the CONTRACTS §8 `code` (the client picks the
 * `fleet.errors.*` sentence by it) and the API's `hint` (shown under it).
 */

export type CheckoutActionResult<T> =
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

function refusal(error: unknown): CheckoutActionResult<never> {
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

/** Every checkout on every computer I may see (Fleet → Checkouts). */
export async function listFleetCheckoutsAction(
    options: { state?: FleetCheckoutState } = {},
): Promise<CheckoutActionResult<FleetCheckoutListResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.list(options) };
    } catch (error) {
        return refusal(error);
    }
}

/** One computer's checkouts; `rescan` scans its code folders now. */
export async function listNodeCheckoutsAction(
    nodeId: string,
    options: { rescan?: boolean; refresh?: boolean; state?: FleetCheckoutState } = {},
): Promise<CheckoutActionResult<FleetNodeCheckoutsResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.listForNode(nodeId, options) };
    } catch (error) {
        return refusal(error);
    }
}

export async function refreshCheckoutAction(
    id: string,
): Promise<CheckoutActionResult<FleetCheckoutOperationResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.refresh(id) };
    } catch (error) {
        return refusal(error);
    }
}

export async function syncCheckoutAction(
    id: string,
    op: FleetCheckoutSyncOp,
    confirm?: boolean,
): Promise<CheckoutActionResult<FleetCheckoutOperationResponse>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.sync(id, op, confirm) };
    } catch (error) {
        return refusal(error);
    }
}

export async function archiveCheckoutAction(
    id: string,
    confirm: boolean,
): Promise<CheckoutActionResult<FleetCheckoutView>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.archive(id, confirm) };
    } catch (error) {
        return refusal(error);
    }
}

export async function restoreCheckoutAction(
    id: string,
): Promise<CheckoutActionResult<FleetCheckoutView>> {
    await ensureAuth();
    try {
        return { success: true, data: await fleetCheckoutsAPI.restore(id) };
    } catch (error) {
        return refusal(error);
    }
}
