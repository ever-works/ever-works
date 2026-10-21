'use server';

import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    fleetAPI,
    type FleetNodeHealthHistory,
    type FleetNodeHealthRange,
    type FleetNodeHealthView,
    type FleetNodeWakeResult,
    type FleetNodeWakeStatus,
} from '@/lib/api/fleet';
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
    const linkError = linkErrorOf(error);
    if (linkError?.hint) return linkError.hint;
    if (error instanceof ApiResponseError && error.message) return error.message;
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

/**
 * The CONTRACTS §8 envelope `{ error: { code, hint } }` a reach act answers
 * with (`unreachable`, `consent_missing`, `kill_switch`, `limit_exceeded`, …),
 * read off the API error so the page can say the hint and branch on the code.
 */
function linkErrorOf(error: unknown): { code: string | null; hint: string | null } | null {
    if (!(error instanceof ApiResponseError)) return null;
    const envelope = (error.details as { error?: { code?: unknown; hint?: unknown } } | undefined)
        ?.error;
    const code = typeof envelope?.code === 'string' ? envelope.code : (error.code ?? null);
    const hint = typeof envelope?.hint === 'string' ? envelope.hint : null;
    return code || hint ? { code, hint } : null;
}

/** A reach act's answer: the data, or the error's code and its hint. */
export type FleetReachActionResult<T> =
    | { success: true; data: T; error: null; code: null }
    | { success: false; data: null; error: string; code: string | null };

async function reach<T>(run: () => Promise<T>, fallback: string): Promise<FleetReachActionResult<T>> {
    await ensureAuth();
    try {
        const data = await run();
        return { success: true, data, error: null, code: null };
    } catch (error) {
        return {
            success: false,
            data: null,
            error: errorMessage(error, fallback),
            code: linkErrorOf(error)?.code ?? null,
        };
    }
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

/**
 * Computer health, second phase (FL-03) — Refresh now: a fresh snapshot over
 * the node link. `view` family; refused `unreachable`, `consent_missing`,
 * `kill_switch` or `limit_exceeded` with the hint to show.
 */
export async function refreshFleetNodeHealthAction(
    nodeId: string,
): Promise<FleetReachActionResult<FleetNodeHealthView>> {
    return reach(() => fleetAPI.refreshHealth(nodeId), 'Could not refresh health');
}

/** Computer health, second phase (FL-03) — one range of a computer's history. */
export async function fetchFleetNodeHealthHistoryAction(
    nodeId: string,
    range: FleetNodeHealthRange,
): Promise<FleetReachActionResult<FleetNodeHealthHistory>> {
    return reach(() => fleetAPI.healthHistory(nodeId, range), 'Could not load history');
}

/**
 * Computer health, second phase (FL-03) — wake an offline computer through a
 * sibling on its network. The ONE state-changing act here: `machines` family
 * on the computer, audited `node.wake` by the API.
 */
export async function wakeFleetNodeAction(
    nodeId: string,
): Promise<FleetReachActionResult<FleetNodeWakeResult>> {
    return reach(() => fleetAPI.wake(nodeId), 'Could not send the wake');
}

/** Computer health, second phase (FL-03) — has the computer answered its last wake? */
export async function fetchFleetNodeWakeStatusAction(
    nodeId: string,
): Promise<FleetReachActionResult<FleetNodeWakeStatus>> {
    return reach(() => fleetAPI.wakeStatus(nodeId), 'Could not read the wake status');
}
