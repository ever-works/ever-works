'use server';

import { redirect } from 'next/navigation';
import {
    isFleetLinkErrorCode,
    type FleetActionConfirmFields,
    type FleetComposeAction,
    type FleetComposeDescription,
    type FleetComposeListResult,
    type FleetContainerAction,
    type FleetContainerExecResult,
    type FleetContainerShellsResult,
    type FleetContainersListResult,
    type FleetImagesListResult,
    type FleetOperationView,
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

// ─── Docker (P2) ────────────────────────────────────────────────────────────

export async function listFleetContainersAction(
    nodeId: string,
): Promise<FleetMachineResult<FleetContainersListResult>> {
    return run(() => fleetMachineAPI.listContainers(nodeId));
}

export async function fleetContainerAction(
    nodeId: string,
    input: { container: string; action: FleetContainerAction; fields?: FleetActionConfirmFields },
): Promise<FleetMachineResult<Record<string, unknown>>> {
    return run(() =>
        fleetMachineAPI.containerAction(
            nodeId,
            input.container,
            input.action,
            confirmOnly(input.fields),
        ),
    );
}

export async function runFleetContainerAction(
    nodeId: string,
    input: { request: unknown; fields?: FleetActionConfirmFields },
): Promise<FleetMachineResult<Record<string, unknown>>> {
    return run(() =>
        fleetMachineAPI.runContainer(nodeId, {
            ...confirmOnly(input.fields),
            request: input.request,
        }),
    );
}

export async function listFleetImagesAction(
    nodeId: string,
): Promise<FleetMachineResult<FleetImagesListResult>> {
    return run(() => fleetMachineAPI.listImages(nodeId));
}

export async function pullFleetImageAction(
    nodeId: string,
    input: { ref: string; fields?: FleetActionConfirmFields },
): Promise<FleetMachineResult<Record<string, unknown>>> {
    return run(() =>
        fleetMachineAPI.pullImage(nodeId, { ...confirmOnly(input.fields), ref: input.ref }),
    );
}

export async function removeFleetImageAction(
    nodeId: string,
    input: { id: string; fields?: FleetActionConfirmFields },
): Promise<FleetMachineResult<Record<string, unknown>>> {
    return run(() => fleetMachineAPI.removeImage(nodeId, input.id, confirmOnly(input.fields)));
}

export async function pruneFleetImagesAction(
    nodeId: string,
    input: { fields?: FleetActionConfirmFields } = {},
): Promise<FleetMachineResult<Record<string, unknown>>> {
    return run(() => fleetMachineAPI.pruneImages(nodeId, confirmOnly(input.fields)));
}

/** One operation's record (pull, run, prune; Compose in P3), for the operation card. */
export async function getFleetOperationAction(
    operationId: string,
): Promise<FleetMachineResult<FleetOperationView>> {
    return run(() => fleetMachineAPI.operation(operationId));
}

export async function cancelFleetOperationAction(
    operationId: string,
): Promise<FleetMachineResult<{ operation: FleetOperationView; sent: boolean }>> {
    return run(() => fleetMachineAPI.cancelOperation(operationId));
}

// ─── Compose and Shell inside (P3) ──────────────────────────────────────────

export async function listFleetComposeAction(
    nodeId: string,
): Promise<FleetMachineResult<FleetComposeListResult>> {
    return run(() => fleetMachineAPI.listCompose(nodeId));
}

export async function describeFleetComposeAction(
    nodeId: string,
    project: string,
): Promise<FleetMachineResult<FleetComposeDescription>> {
    return run(() => fleetMachineAPI.describeCompose(nodeId, project));
}

export async function fleetComposeAction(
    nodeId: string,
    input: {
        project: string;
        action: FleetComposeAction;
        service?: string;
        fields?: FleetActionConfirmFields;
    },
): Promise<FleetMachineResult<Record<string, unknown>>> {
    return run(() =>
        fleetMachineAPI.composeAction(nodeId, input.project, input.action, {
            ...confirmOnly(input.fields),
            ...(input.service ? { service: input.service } : {}),
        }),
    );
}

export async function fleetContainerShellsAction(
    nodeId: string,
    container: string,
): Promise<FleetMachineResult<FleetContainerShellsResult>> {
    return run(() => fleetMachineAPI.containerShells(nodeId, container));
}

/** Shell inside: starts an owner Session (FL-04) and answers its id for the session page. */
export async function execInFleetContainerAction(
    nodeId: string,
    input: { container: string; shell: 'bash' | 'sh' },
): Promise<FleetMachineResult<FleetContainerExecResult>> {
    return run(() => fleetMachineAPI.execInContainer(nodeId, input.container, input.shell));
}
