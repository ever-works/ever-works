'use server';

import { redirect } from 'next/navigation';
import {
    isFleetLinkErrorCode,
    isFleetUsagePeriodDays,
    type FleetLinkError,
    type FleetUsagePricesView,
    type FleetUsageRescanResult,
    type FleetUsageTaskCostsView,
    type FleetUsageView,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetUsageAPI } from '@/lib/api/fleet-usage';

/**
 * Usage & cost on the fleet (FL-20) — Server Actions over `/api/fleet/usage`.
 *
 * Every answer is `{ ok: true, data } | { ok: false, error }` where `error` is
 * the CONTRACTS §8 envelope's `{ code, hint, details }` read off the API's
 * body — never off a thrown message (production redacts those) — so a block
 * says "Usage scan is off — run … on build-01" with the code to branch on.
 */

export type FleetUsageResult<T> = { ok: true; data: T } | { ok: false; error: FleetLinkError };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function usageError(error: unknown): FleetLinkError {
    if (error instanceof ApiResponseError) {
        const body = error.details as { error?: unknown } | undefined;
        const inner = body && typeof body === 'object' ? body.error : undefined;
        if (inner && typeof inner === 'object') {
            const raw = inner as { code?: unknown; hint?: unknown; details?: unknown };
            if (isFleetLinkErrorCode(raw.code)) {
                return {
                    code: raw.code,
                    hint: typeof raw.hint === 'string' ? raw.hint : '',
                    ...(raw.details && typeof raw.details === 'object'
                        ? { details: raw.details as Record<string, unknown> }
                        : {}),
                };
            }
        }
        if (error.statusCode === 404) return { code: 'not_found', hint: '' };
        if (error.statusCode === 403) return { code: 'permission_denied', hint: '' };
    }
    return { code: 'internal', hint: '' };
}

async function run<T>(call: () => Promise<T>): Promise<FleetUsageResult<T>> {
    await ensureAuth();
    try {
        return { ok: true, data: await call() };
    } catch (error) {
        return { ok: false, error: usageError(error) };
    }
}

/** The Usage object — the hub tab, the computer Overview line (`node`), a model filter. */
export async function getFleetUsageAction(input: {
    days?: number;
    node?: string | null;
    model?: string | null;
    /** P2 — one Agent's work only. */
    agent?: string | null;
}): Promise<FleetUsageResult<FleetUsageView>> {
    const days = isFleetUsagePeriodDays(input.days) ? input.days : undefined;
    return run(() =>
        fleetUsageAPI.view({
            days,
            node: input.node ?? null,
            model: input.model ?? null,
            agent: input.agent ?? null,
        }),
    );
}

/** P2 — the schedule rows' cost: each recurring Task's newest Run and its 30-day total (own Runs only). */
export async function getFleetUsageTaskCostsAction(
    taskIds: string[],
): Promise<FleetUsageResult<FleetUsageTaskCostsView>> {
    const ids = taskIds.filter((id) => typeof id === 'string' && id.length > 0).slice(0, 50);
    if (ids.length === 0) {
        await ensureAuth();
        return { ok: true, data: { tasks: [], note: '' } };
    }
    return run(() => fleetUsageAPI.taskCosts(ids));
}

/** The price list in effect and its version history (read-only). */
export async function getFleetUsagePricesAction(): Promise<FleetUsageResult<FleetUsagePricesView>> {
    return run(() => fleetUsageAPI.prices());
}

/** Ask one computer to scan now (owner only; `unreachable`, `consent_missing`, `kill_switch`). */
export async function rescanFleetUsageAction(
    nodeId: string,
): Promise<FleetUsageResult<FleetUsageRescanResult>> {
    return run(() => fleetUsageAPI.rescan(nodeId));
}
