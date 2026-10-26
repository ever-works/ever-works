'use server';

import { redirect } from 'next/navigation';
import {
    isFleetLinkErrorCode,
    type FleetCloudCreateRequest,
    type FleetCloudCreateResponse,
    type FleetCloudIdlePolicy,
    type FleetCloudListView,
    type FleetCloudOperationResponse,
    type FleetCloudOptionsView,
    type FleetCloudPowerAction,
    type FleetCloudProvidersView,
    type FleetCloudUsageView,
    type FleetLinkError,
    type FleetNodeView,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetCloudAPI } from '@/lib/api/fleet-cloud';

/**
 * Cloud computers (FL-17) — Server Actions over `/api/fleet/providers` and
 * `/api/fleet/cloud`.
 *
 * Every answer is `{ ok: true, data } | { ok: false, error }` where `error` is
 * the CONTRACTS §8 envelope's `{ code, hint, details }` read off the API's
 * body — never off a thrown message (production redacts those). The dialogs
 * read `confirmation_required` (class, summary) and `invalid` with
 * `currentPriceCents` (the price changed) straight from it.
 */

export type FleetCloudResult<T> = { ok: true; data: T } | { ok: false; error: FleetLinkError };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function cloudError(error: unknown): FleetLinkError {
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

async function run<T>(call: () => Promise<T>): Promise<FleetCloudResult<T>> {
    await ensureAuth();
    try {
        return { ok: true, data: await call() };
    } catch (error) {
        return { ok: false, error: cloudError(error) };
    }
}

export async function listFleetCloudProvidersAction(): Promise<FleetCloudResult<FleetCloudProvidersView>> {
    return run(() => fleetCloudAPI.providers());
}

export async function fleetCloudOptionsAction(pluginId: string): Promise<FleetCloudResult<FleetCloudOptionsView>> {
    return run(() => fleetCloudAPI.options(pluginId));
}

export async function listFleetCloudAction(): Promise<FleetCloudResult<FleetCloudListView & FleetCloudProvidersView>> {
    return run(() => fleetCloudAPI.list());
}

export async function createFleetCloudAction(
    request: FleetCloudCreateRequest,
): Promise<FleetCloudResult<FleetCloudCreateResponse>> {
    const body: FleetCloudCreateRequest = {
        providerPluginId: request.providerPluginId,
        name: request.name,
        regionId: request.regionId,
        sizeId: request.sizeId,
        acknowledgedPriceCents: request.acknowledgedPriceCents,
        ...(request.software ? { software: request.software } : {}),
        ...(request.confirm === true ? { confirm: true } : {}),
    };
    return run(() => fleetCloudAPI.create(body));
}

export async function fleetCloudPowerAction(
    nodeId: string,
    action: FleetCloudPowerAction,
    confirm = false,
): Promise<FleetCloudResult<FleetCloudOperationResponse>> {
    return run(() => fleetCloudAPI.power(nodeId, action, confirm));
}

export async function destroyFleetCloudAction(
    nodeId: string,
    confirmName?: string,
): Promise<FleetCloudResult<FleetCloudOperationResponse>> {
    return run(() => fleetCloudAPI.destroy(nodeId, confirmName));
}

/** P2 (spec S8, FR-23) — the Cloud computers usage block: estimates from list prices. */
export async function fleetCloudUsageAction(): Promise<FleetCloudResult<FleetCloudUsageView>> {
    return run(() => fleetCloudAPI.usage());
}

/** P2 (spec FR-25) — the idle policy; the API validates the mode and the 1–72 hours again. */
export async function setFleetCloudIdlePolicyAction(
    nodeId: string,
    policy: FleetCloudIdlePolicy,
): Promise<FleetCloudResult<FleetNodeView>> {
    return run(() => fleetCloudAPI.setIdlePolicy(nodeId, { mode: policy.mode, afterHours: policy.afterHours }));
}

/** P2 (spec S6) — "Keep running": the idle window starts again now. */
export async function keepFleetCloudRunningAction(nodeId: string): Promise<FleetCloudResult<FleetNodeView>> {
    return run(() => fleetCloudAPI.keepRunning(nodeId));
}
