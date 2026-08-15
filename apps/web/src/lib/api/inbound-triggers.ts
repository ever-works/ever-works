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

/** What fires the trigger: the signed endpoint, or ingest-spine event matching. */
export type InboundTriggerSourceType = 'webhook' | 'event';

/** Matcher for 'event'-sourced triggers; source/kind allow a trailing-`*` wildcard. */
export interface InboundTriggerEventMatcher {
    source?: string;
    kind?: string;
    workId?: string;
}

/** What a fire produces — locked when the trigger is created. */
export type InboundTriggerMode = 'single-task' | 'template';

/** Whether the first Task of a fire is dispatched or parked in the backlog. */
export type InboundTriggerAutoStart = 'always' | 'manual';

/** One declared payload variable; `required` ones gate the fire. */
export interface InboundTriggerVariable {
    key: string;
    label?: string;
    required: boolean;
}

export type InboundTriggerFireOrigin = 'webhook' | 'event' | 'manual' | 'test';

export type InboundTriggerFireStatus = 'running' | 'done' | 'failed' | 'refused';

/** One row of a trigger's recent-fires log. */
export interface InboundTriggerFireView {
    id: string;
    origin: InboundTriggerFireOrigin;
    status: InboundTriggerFireStatus;
    reason: string | null;
    taskId: string | null;
    firedAt: string;
}

export interface InboundTriggerView {
    id: string;
    name: string;
    description: string | null;
    kind: InboundTriggerKind;
    status: InboundTriggerStatus;
    sourceType: InboundTriggerSourceType;
    eventMatcher: InboundTriggerEventMatcher | null;
    targetAgentId: string | null;
    taskTitleTemplate: string | null;
    taskDescriptionTemplate: string | null;
    /** Reserved task-template linkage (slug) — resolved lazily at fire time. */
    taskTemplateSlug: string | null;
    /** What a fire produces — locked at create time. */
    mode: InboundTriggerMode;
    /** 'single-task' instructions; the payload is appended in a <webhook_body> block. */
    agentPrompt: string | null;
    showOnBoard: boolean;
    replayWindowSec: number;
    autoStart: InboundTriggerAutoStart;
    defaultVariables: InboundTriggerVariable[] | null;
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
    sourceType?: InboundTriggerSourceType;
    eventMatcher?: InboundTriggerEventMatcher;
    targetAgentId?: string;
    taskTitleTemplate?: string;
    taskDescriptionTemplate?: string;
    taskTemplateSlug?: string;
    /** Locked after create — omit to keep the 'single-task' default. */
    mode?: InboundTriggerMode;
    agentPrompt?: string;
    showOnBoard?: boolean;
    replayWindowSec?: number;
    autoStart?: InboundTriggerAutoStart;
    defaultVariables?: { key: string; label?: string; required?: boolean }[];
}

export interface UpdateInboundTriggerInput {
    name?: string;
    description?: string | null;
    eventMatcher?: InboundTriggerEventMatcher;
    targetAgentId?: string | null;
    taskTitleTemplate?: string | null;
    taskDescriptionTemplate?: string | null;
    taskTemplateSlug?: string | null;
    agentPrompt?: string | null;
    showOnBoard?: boolean;
    replayWindowSec?: number;
    autoStart?: InboundTriggerAutoStart;
    defaultVariables?: { key: string; label?: string; required?: boolean }[] | null;
    // `mode` is intentionally absent — the API rejects it (locked at create).
}

export interface TestFireInboundTriggerResult {
    ok: true;
    taskId: string;
    taskSlug: string;
    taskTitle: string;
}

/** 'Fire now' — an owner-initiated REAL fire (counters bump, autoStart honoured). */
export type FireNowInboundTriggerResult = TestFireInboundTriggerResult;

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

    update: async (id: string, input: UpdateInboundTriggerInput): Promise<InboundTriggerView> => {
        return serverFetch<InboundTriggerView>(`/inbound-triggers/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(input),
        });
    },

    testFire: async (id: string): Promise<TestFireInboundTriggerResult> => {
        return serverFetch<TestFireInboundTriggerResult>(`/inbound-triggers/${id}/test-fire`, {
            method: 'POST',
        });
    },

    fireNow: async (id: string): Promise<FireNowInboundTriggerResult> => {
        return serverFetch<FireNowInboundTriggerResult>(`/inbound-triggers/${id}/fire-now`, {
            method: 'POST',
        });
    },

    listFires: async (id: string): Promise<InboundTriggerFireView[]> => {
        const res = await serverFetch<{ fires: InboundTriggerFireView[] }>(
            `/inbound-triggers/${id}/fires`,
        );
        return res.fires;
    },

    getOne: async (id: string): Promise<InboundTriggerView> => {
        return serverFetch<InboundTriggerView>(`/inbound-triggers/${id}`);
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
