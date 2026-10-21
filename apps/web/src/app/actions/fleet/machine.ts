'use server';

import { redirect } from 'next/navigation';
import {
    isFleetLinkErrorCode,
    type FleetActionConfirmFields,
    type FleetLinkError,
    type FleetOperationRef,
    type FleetProcessesListResult,
    type FleetProcessSignal,
    type FleetProcessSignalResult,
    type FleetProcessSort,
    type FleetServiceAction,
    type FleetServiceActionResult,
    type FleetServiceManager,
    type FleetServiceScope,
    type FleetServicesListResult,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetMachineAPI } from '@/lib/api/fleet-machine';

/**
 * Services, Docker, Compose and processes on computers (FL-09) — Server
 * Actions over the machine-action routes.
 *
 * Every answer is `{ ok: true, data } | { ok: false, error }` where `error`
 * is the CONTRACTS §8 envelope's `{ code, hint, details }` — read off the
 * API's body, never off a thrown message (production redacts thrown action
 * messages, so a client must never branch on one). The dialogs read
 * `confirmation_required` (class, summary, sentence) and `root_required`
 * (the exact command) straight from it.
 */

export type FleetMachineResult<T> = { ok: true; data: T } | { ok: false; error: FleetLinkError };

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

/** The CONTRACTS §8 error of a failed call (the API body's `error`), or `internal`. */
function machineError(error: unknown): FleetLinkError {
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

async function run<T>(call: () => Promise<T>): Promise<FleetMachineResult<T>> {
    await ensureAuth();
    try {
        return { ok: true, data: await call() };
    } catch (error) {
        return { ok: false, error: machineError(error) };
    }
}

/** Only the three CONTRACTS §2.2 fields, whatever the caller passed. */
function confirmOnly(fields: FleetActionConfirmFields | undefined): FleetActionConfirmFields {
    const out: FleetActionConfirmFields = {};
    if (fields?.confirm === true) out.confirm = true;
    if (typeof fields?.confirmName === 'string') out.confirmName = fields.confirmName;
    if (fields?.acknowledgeBlastRadius === true) out.acknowledgeBlastRadius = true;
    return out;
}

export async function listFleetServicesAction(
    nodeId: string,
    options: { scope?: FleetServiceScope | 'all'; find?: string } = {},
): Promise<FleetMachineResult<FleetServicesListResult>> {
    return run(() => fleetMachineAPI.listServices(nodeId, options));
}

export async function fleetServiceAction(
    nodeId: string,
    input: {
        name: string;
        action: FleetServiceAction;
        scope?: FleetServiceScope;
        manager?: FleetServiceManager;
        fields?: FleetActionConfirmFields;
    },
): Promise<FleetMachineResult<FleetServiceActionResult | FleetOperationRef>> {
    return run(() =>
        fleetMachineAPI.serviceAction(nodeId, input.name, input.action, {
            ...confirmOnly(input.fields),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.manager ? { manager: input.manager } : {}),
        }),
    );
}

export async function listFleetProcessesAction(
    nodeId: string,
    options: { sort?: FleetProcessSort; find?: string } = {},
): Promise<FleetMachineResult<FleetProcessesListResult>> {
    return run(() => fleetMachineAPI.listProcesses(nodeId, options));
}

export async function signalFleetProcessAction(
    nodeId: string,
    input: { pid: number; signal: FleetProcessSignal; fields?: FleetActionConfirmFields },
): Promise<FleetMachineResult<FleetProcessSignalResult | FleetOperationRef>> {
    return run(() =>
        fleetMachineAPI.signalProcess(nodeId, input.pid, {
            ...confirmOnly(input.fields),
            signal: input.signal,
        }),
    );
}
