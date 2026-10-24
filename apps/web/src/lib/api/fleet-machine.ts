import 'server-only';
import type {
    FleetActionConfirmFields,
    FleetComposeAction,
    FleetComposeDescription,
    FleetComposeListResult,
    FleetContainerAction,
    FleetContainerExecResult,
    FleetContainerShellsResult,
    FleetContainersListResult,
    FleetImagesListResult,
    FleetOperationView,
    FleetOperationRef,
    FleetProcessesListResult,
    FleetProcessSignal,
    FleetProcessSignalResult,
    FleetProcessSort,
    FleetServiceAction,
    FleetServiceActionResult,
    FleetServiceManager,
    FleetServiceScope,
    FleetServicesListResult,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Services, Docker, Compose and processes on computers (FL-09) — the web
 * client for the machine-action routes under `/api/fleet/nodes/:id/…`
 * (`apps/api/src/fleet/machine/`). The CONTRACTS §2.2 confirmation fields are
 * forwarded verbatim: the API decides the class, the dialog only echoes it.
 */

const BASE = '/fleet/nodes';

function query(params: Record<string, string | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') search.set(key, value);
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

export const fleetMachineAPI = {
    listServices: async (nodeId: string, options: { scope?: FleetServiceScope | 'all'; find?: string } = {}) =>
        serverFetch<FleetServicesListResult>(
            `${BASE}/${encodeURIComponent(nodeId)}/services${query({ scope: options.scope, find: options.find })}`,
        ),

    serviceAction: async (
        nodeId: string,
        name: string,
        action: FleetServiceAction,
        body: FleetActionConfirmFields & { scope?: FleetServiceScope; manager?: FleetServiceManager },
    ) =>
        serverMutation<FleetServiceActionResult | FleetOperationRef>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/services/${encodeURIComponent(name)}/${encodeURIComponent(action)}`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    listProcesses: async (nodeId: string, options: { sort?: FleetProcessSort; find?: string } = {}) =>
        serverFetch<FleetProcessesListResult>(
            `${BASE}/${encodeURIComponent(nodeId)}/processes${query({ sort: options.sort, find: options.find })}`,
        ),

    signalProcess: async (
        nodeId: string,
        pid: number,
        body: FleetActionConfirmFields & { signal: FleetProcessSignal },
    ) =>
        serverMutation<FleetProcessSignalResult | FleetOperationRef>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/processes/${encodeURIComponent(String(pid))}/signal`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    // ─── Docker (P2) ──────────────────────────────────────────────────────
    listContainers: async (nodeId: string) =>
        serverFetch<FleetContainersListResult>(`${BASE}/${encodeURIComponent(nodeId)}/docker/containers`),

    containerAction: async (
        nodeId: string,
        container: string,
        action: FleetContainerAction,
        body: FleetActionConfirmFields,
    ) =>
        serverMutation<Record<string, unknown>>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/containers/${encodeURIComponent(container)}/${encodeURIComponent(action)}`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    runContainer: async (nodeId: string, body: FleetActionConfirmFields & { request: unknown }) =>
        serverMutation<Record<string, unknown>>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/containers`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    listImages: async (nodeId: string) =>
        serverFetch<FleetImagesListResult>(`${BASE}/${encodeURIComponent(nodeId)}/docker/images`),

    pullImage: async (nodeId: string, body: FleetActionConfirmFields & { ref: string }) =>
        serverMutation<Record<string, unknown>>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/images`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    removeImage: async (nodeId: string, imageId: string, body: FleetActionConfirmFields) =>
        serverMutation<Record<string, unknown>>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/images/${encodeURIComponent(imageId)}/remove`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    pruneImages: async (nodeId: string, body: FleetActionConfirmFields) =>
        serverMutation<Record<string, unknown>>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/images?unused=true`,
            data: body,
            method: 'DELETE',
            wrapInData: false,
        }),

    // ─── Compose and Shell inside (P3) ────────────────────────────────────
    listCompose: async (nodeId: string) =>
        serverFetch<FleetComposeListResult>(`${BASE}/${encodeURIComponent(nodeId)}/docker/compose`),

    describeCompose: async (nodeId: string, project: string) =>
        serverFetch<FleetComposeDescription>(
            `${BASE}/${encodeURIComponent(nodeId)}/docker/compose?project=${encodeURIComponent(project)}`,
        ),

    composeAction: async (
        nodeId: string,
        project: string,
        action: FleetComposeAction,
        body: FleetActionConfirmFields & { service?: string },
    ) =>
        serverMutation<Record<string, unknown>>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/compose/${encodeURIComponent(project)}/${encodeURIComponent(action)}`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    containerShells: async (nodeId: string, container: string) =>
        serverFetch<FleetContainerShellsResult>(
            `${BASE}/${encodeURIComponent(nodeId)}/docker/containers/${encodeURIComponent(container)}/shells`,
        ),

    execInContainer: async (nodeId: string, container: string, shell: 'bash' | 'sh') =>
        serverMutation<FleetContainerExecResult>({
            endpoint: `${BASE}/${encodeURIComponent(nodeId)}/docker/containers/${encodeURIComponent(container)}/exec`,
            data: { shell },
            method: 'POST',
            wrapInData: false,
        }),

    /** FL-02's operation record (`GET /api/fleet/operations/:id`): state, progress, result or error. */
    operation: async (operationId: string) =>
        serverFetch<FleetOperationView>(`/fleet/operations/${encodeURIComponent(operationId)}`),

    /** FL-02: ask the computer to cancel a running operation. */
    cancelOperation: async (operationId: string) =>
        serverMutation<{ operation: FleetOperationView; sent: boolean }>({
            endpoint: `/fleet/operations/${encodeURIComponent(operationId)}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        }),
};
