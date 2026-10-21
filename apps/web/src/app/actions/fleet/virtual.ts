'use server';

import { redirect } from 'next/navigation';
import {
    isFleetLinkErrorCode,
    type FleetActionConfirmFields,
    type FleetLinkError,
    type FleetVirtualChildrenListView,
    type FleetVirtualCreateRequest,
    type FleetVirtualCreateResponse,
    type FleetVirtualOperationResponse,
    type FleetVirtualOptionsView,
    type FleetVirtualPowerAction,
    type FleetVirtualSystemId,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetVirtualAPI } from '@/lib/api/fleet-virtual';

/**
 * Virtual computers (FL-16) — Server Actions over `/api/fleet/nodes/:id/virtual`.
 *
 * Every answer is `{ ok: true, data } | { ok: false, error }` where `error` is
 * the CONTRACTS §8 envelope's `{ code, hint, details }` read off the API's
 * body — never off a thrown message (production redacts those). The dialogs
 * read `confirmation_required` (class, summary) straight from it and repeat
 * the call with `confirm` / `confirmName`.
 */

export type FleetVirtualResult<T> = { ok: true; data: T } | { ok: false; error: FleetLinkError };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

function virtualError(error: unknown): FleetLinkError {
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

async function run<T>(call: () => Promise<T>): Promise<FleetVirtualResult<T>> {
    await ensureAuth();
    try {
        return { ok: true, data: await call() };
    } catch (error) {
        return { ok: false, error: virtualError(error) };
    }
}

export async function listFleetVirtualChildrenAction(
    hostNodeId: string,
): Promise<FleetVirtualResult<FleetVirtualChildrenListView>> {
    return run(() => fleetVirtualAPI.listChildren(hostNodeId));
}

export async function fleetVirtualOptionsAction(
    hostNodeId: string | 'auto',
    systemId?: FleetVirtualSystemId,
): Promise<FleetVirtualResult<FleetVirtualOptionsView>> {
    return run(() => fleetVirtualAPI.options(hostNodeId, systemId));
}

export async function createFleetVirtualAction(
    hostNodeId: string | 'auto',
    request: FleetVirtualCreateRequest,
): Promise<FleetVirtualResult<FleetVirtualCreateResponse>> {
    const body: FleetVirtualCreateRequest = {
        name: request.name,
        systemId: request.systemId,
        cpus: request.cpus,
        memoryGiB: request.memoryGiB,
        ...(request.diskGiB ? { diskGiB: request.diskGiB } : {}),
        ...(request.confirm === true ? { confirm: true } : {}),
    };
    return run(() => fleetVirtualAPI.create(hostNodeId, body));
}

export async function fleetVirtualPowerAction(
    hostNodeId: string,
    childNodeId: string,
    action: FleetVirtualPowerAction,
    fields: FleetActionConfirmFields = {},
): Promise<FleetVirtualResult<FleetVirtualOperationResponse>> {
    return run(() => fleetVirtualAPI.power(hostNodeId, childNodeId, action, fields));
}

export async function destroyFleetVirtualAction(
    hostNodeId: string,
    childNodeId: string,
    confirmName?: string,
): Promise<FleetVirtualResult<FleetVirtualOperationResponse>> {
    return run(() => fleetVirtualAPI.destroy(hostNodeId, childNodeId, confirmName));
}

export async function retryFleetVirtualEnrollmentAction(
    hostNodeId: string,
    childNodeId: string,
): Promise<FleetVirtualResult<FleetVirtualOperationResponse>> {
    return run(() => fleetVirtualAPI.retryEnrollment(hostNodeId, childNodeId));
}
