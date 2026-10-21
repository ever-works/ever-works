import 'server-only';
import type {
    FleetActionConfirmFields,
    FleetVirtualChildrenListView,
    FleetVirtualCreateRequest,
    FleetVirtualCreateResponse,
    FleetVirtualOperationResponse,
    FleetVirtualOptionsView,
    FleetVirtualPasswordRevealResponse,
    FleetVirtualPowerAction,
    FleetVirtualSystemId,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';

/**
 * Virtual computers (FL-16) — the web client for `/api/fleet/nodes/:id/virtual`
 * (`apps/api/src/fleet/virtual/`). The CONTRACTS §2.2 confirmation fields are
 * forwarded verbatim: the API decides the class, the dialog only echoes it.
 */

const BASE = '/fleet/nodes';

export const fleetVirtualAPI = {
    listChildren: async (hostNodeId: string) =>
        serverFetch<FleetVirtualChildrenListView>(`${BASE}/${encodeURIComponent(hostNodeId)}/virtual`),

    options: async (hostNodeId: string | 'auto', systemId?: FleetVirtualSystemId) =>
        serverFetch<FleetVirtualOptionsView>(
            `${BASE}/${encodeURIComponent(hostNodeId)}/virtual/options${systemId ? `?system=${encodeURIComponent(systemId)}` : ''}`,
        ),

    create: async (hostNodeId: string | 'auto', body: FleetVirtualCreateRequest) =>
        serverMutation<FleetVirtualCreateResponse>({
            endpoint: `${BASE}/${encodeURIComponent(hostNodeId)}/virtual`,
            data: body,
            method: 'POST',
            wrapInData: false,
        }),

    power: async (hostNodeId: string, childNodeId: string, action: FleetVirtualPowerAction, fields: FleetActionConfirmFields) =>
        serverMutation<FleetVirtualOperationResponse>({
            endpoint: `${BASE}/${encodeURIComponent(hostNodeId)}/virtual/${encodeURIComponent(childNodeId)}/power`,
            data: { action, ...(fields.confirm === true ? { confirm: true } : {}) },
            method: 'POST',
            wrapInData: false,
        }),

    destroy: async (hostNodeId: string, childNodeId: string, confirmName: string | undefined) =>
        serverMutation<FleetVirtualOperationResponse>({
            endpoint: `${BASE}/${encodeURIComponent(hostNodeId)}/virtual/${encodeURIComponent(childNodeId)}/destroy`,
            data: confirmName !== undefined ? { confirmName } : {},
            method: 'POST',
            wrapInData: false,
        }),

    /** Windows VMs (P2): the one-time password reveal — `confirm: true`, owner only, never cached. */
    revealPassword: async (hostNodeId: string, childNodeId: string) =>
        serverMutation<FleetVirtualPasswordRevealResponse>({
            endpoint: `${BASE}/${encodeURIComponent(hostNodeId)}/virtual/${encodeURIComponent(childNodeId)}/password/reveal`,
            data: { confirm: true },
            method: 'POST',
            wrapInData: false,
        }),

    retryEnrollment: async (hostNodeId: string, childNodeId: string) =>
        serverMutation<FleetVirtualOperationResponse>({
            endpoint: `${BASE}/${encodeURIComponent(hostNodeId)}/virtual/${encodeURIComponent(childNodeId)}/retry-enrollment`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
};
