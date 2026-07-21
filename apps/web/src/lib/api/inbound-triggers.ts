import 'server-only';
import { serverFetch } from './server-api';

/**
 * Inbound Triggers — server-only API client. Mirrors the agent-side
 * `InboundTriggerView` contract as a local interface (same convention as
 * `lib/api/schedules.ts`), so apps/web never takes a runtime dependency on
 * `@ever-works/agent`.
 */

export type InboundTriggerKind = 'webhook' | 'api';

export type InboundTriggerStatus = 'active' | 'paused';

export interface InboundTriggerView {
    id: string;
    name: string;
    description: string | null;
    kind: InboundTriggerKind;
    status: InboundTriggerStatus;
    targetAgentId: string | null;
    taskTitleTemplate: string | null;
    /** ISO 8601, or null when the trigger never fired. */
    lastFiredAt: string | null;
    fireCount: number;
    /** ISO 8601, or null when the secret was never rotated. */
    rotatedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateInboundTriggerInput {
    name: string;
    description?: string;
    kind?: InboundTriggerKind;
    targetAgentId?: string;
    taskTitleTemplate?: string;
}

/** The RAW signing secret is present ONLY in create + rotate responses. */
export interface InboundTriggerWithSecret {
    trigger: InboundTriggerView;
    secret: string;
}

export const inboundTriggersAPI = {
    list: async (): Promise<InboundTriggerView[]> => {
        const res = await serverFetch<{ triggers: InboundTriggerView[] }>('/inbound-triggers');
        return res.triggers;
    },

    create: async (input: CreateInboundTriggerInput): Promise<InboundTriggerWithSecret> => {
        return serverFetch<InboundTriggerWithSecret>('/inbound-triggers', {
            method: 'POST',
            body: JSON.stringify(input),
        });
    },

    rotateSecret: async (id: string): Promise<InboundTriggerWithSecret> => {
        return serverFetch<InboundTriggerWithSecret>(`/inbound-triggers/${id}/rotate-secret`, {
            method: 'POST',
        });
    },

    pause: async (id: string): Promise<InboundTriggerView> => {
        return serverFetch<InboundTriggerView>(`/inbound-triggers/${id}/pause`, {
            method: 'POST',
        });
    },

    resume: async (id: string): Promise<InboundTriggerView> => {
        return serverFetch<InboundTriggerView>(`/inbound-triggers/${id}/resume`, {
            method: 'POST',
        });
    },

    remove: async (id: string): Promise<void> => {
        await serverFetch<void>(`/inbound-triggers/${id}`, { method: 'DELETE' });
    },
};
