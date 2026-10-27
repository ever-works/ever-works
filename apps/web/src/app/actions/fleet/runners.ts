'use server';

import { redirect } from 'next/navigation';
import {
    isFleetLinkErrorCode,
    type FleetActionsRunnerInstallRequest,
    type FleetActionsRunnerInstallResponse,
    type FleetActionsRunnerOperationResponse,
    type FleetActionsRunnerOptionsView,
    type FleetActionsRunnersListView,
    type FleetLinkError,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetActionsRunnersAPI } from '@/lib/api/fleet-actions-runners';

/**
 * Actions runners on computers (FL-18 P1) — Server Actions over
 * `/api/fleet/nodes/:id/runners/**`.
 *
 * Every answer is `{ ok: true, data } | { ok: false, error }` where `error` is
 * the CONTRACTS §8 envelope's `{ code, hint, details }` read off the API's
 * body — never off a thrown message (production redacts those). The row
 * dialogs read `confirmation_required` (class, summary, target) and the
 * Install dialog `root_required` (the exact command) straight from it. A 404
 * (`FLEET_ACTIONS_RUNNERS_ENABLED` off, or no such computer) is `not_found`.
 */

export type FleetActionsRunnersResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: FleetLinkError };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function runnersError(error: unknown): FleetLinkError {
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

async function run<T>(call: () => Promise<T>): Promise<FleetActionsRunnersResult<T>> {
    await ensureAuth();
    try {
        return { ok: true, data: await call() };
    } catch (error) {
        return { ok: false, error: runnersError(error) };
    }
}

/** The runners on one computer, with when GitHub was last read, the rate limit and the kill switch. */
export async function listFleetActionsRunnersAction(
    nodeId: string,
): Promise<FleetActionsRunnersResult<FleetActionsRunnersListView>> {
    return run(() => fleetActionsRunnersAPI.list(nodeId));
}

/** What the Install dialog offers on one computer (targets, modes, names) and whether it can host runners. */
export async function fleetActionsRunnerOptionsAction(
    nodeId: string,
): Promise<FleetActionsRunnersResult<FleetActionsRunnerOptionsView>> {
    return run(() => fleetActionsRunnersAPI.options(nodeId));
}

/** Install 1–16 runners (the dialog is the confirmation: `confirm: true`). Answers 202 with the new rows' ids. */
export async function installFleetActionsRunnersAction(
    nodeId: string,
    request: FleetActionsRunnerInstallRequest,
): Promise<FleetActionsRunnersResult<FleetActionsRunnerInstallResponse>> {
    const body: FleetActionsRunnerInstallRequest = {
        target: { scope: request.target.scope, target: request.target.target },
        count: request.count,
        ...(request.names ? { names: request.names } : {}),
        ...(request.labels ? { labels: request.labels } : {}),
        ...(request.mode ? { mode: request.mode } : {}),
        ...(request.confirm === true ? { confirm: true } : {}),
    };
    return run(() => fleetActionsRunnersAPI.install(nodeId, body));
}

/** Start, stop or restart one runner (stop and restart need `confirm`). Answers 202. */
export async function fleetActionsRunnerControlAction(
    nodeId: string,
    runnerId: string,
    action: 'start' | 'stop' | 'restart',
    confirm = false,
): Promise<FleetActionsRunnersResult<FleetActionsRunnerOperationResponse>> {
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
        return { ok: false, error: { code: 'invalid', hint: '' } };
    }
    return run(() => fleetActionsRunnersAPI.control(nodeId, runnerId, action, confirm));
}

/** Remove one runner: `confirmName` must be its name (typed). Answers 202. */
export async function removeFleetActionsRunnerAction(
    nodeId: string,
    runnerId: string,
    confirmName?: string,
): Promise<FleetActionsRunnersResult<FleetActionsRunnerOperationResponse>> {
    return run(() => fleetActionsRunnersAPI.remove(nodeId, runnerId, confirmName));
}
