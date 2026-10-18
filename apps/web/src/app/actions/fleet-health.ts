'use server';

import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetAPI, type FleetNodeHealthView } from '@/lib/api/fleet';
import type { FleetActionResult } from './settings/fleet';

/**
 * Computer health (FL-03) — Server Actions over the read side of a
 * computer's health. Same posture as `app/actions/settings/fleet.ts`: the
 * session is re-verified at the boundary (the API is the final guard) and the
 * answer is the discriminated `{ success, data, error }` shape, so a client
 * block renders "Could not load health — Try again" instead of re-throwing
 * across the RSC boundary (production redacts thrown action messages).
 *
 * Reads only: nothing here changes a machine. The one fix a state offers
 * that the platform can perform — "Clear limit now" — is the existing,
 * audited `clearFleetNodeModelThrottleAction`.
 */

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiResponseError && error.message) return error.message;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

/** One computer's health: snapshot, staleness, state and its fix. */
export async function fetchFleetNodeHealthAction(
    nodeId: string,
): Promise<FleetActionResult<FleetNodeHealthView>> {
    await ensureAuth();
    try {
        const data = await fleetAPI.health(nodeId);
        return { success: true, data, error: null };
    } catch (error) {
        return { success: false, data: null, error: errorMessage(error, 'Failed to load health') };
    }
}
