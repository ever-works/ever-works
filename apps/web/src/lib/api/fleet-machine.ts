import 'server-only';
import type {
    FleetActionConfirmFields,
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
};
