import 'server-only';
import type { AgentInboxDto, AgentInboxMode, EmailMessageStatus } from '@ever-works/contracts';
import type { AgentEmailSendPolicyView } from '../agent-email-policy';
import { serverFetch, serverMutation } from './server-api';

/**
 * EW-650 / EW-679 — server-side API client for tenant email addresses.
 * Mirrors the api-keys client shape.
 */

export type EmailAddressDirection = 'outbound' | 'inbound' | 'both';

export interface EmailAddress {
    id: string;
    userId: string;
    address: string;
    direction: EmailAddressDirection;
    pluginId: string;
    providerSettings: Record<string, unknown>;
    verified: boolean;
    defaultForReplies: boolean;
    disabledAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateEmailAddressDto {
    address: string;
    direction: EmailAddressDirection;
    pluginId: string;
    providerSettings: Record<string, unknown>;
    defaultForReplies?: boolean;
}

export interface EmailMessageListItem {
    id: string;
    direction: 'outbound' | 'inbound';
    from: string;
    toAddresses: string[];
    subject: string;
    pluginId: string;
    sentAt: string | null;
    receivedAt: string | null;
    deliveryStatus: string | null;
    createdAt: string;
    /** AW-05 — where the message is in its life (`draft` waits for approval). */
    status?: EmailMessageStatus | null;
    approvedById?: string | null;
    failureReason?: string | null;
}

/** AW-05 — which of the owner's addresses an Agent sends from / receives at. */
export interface AgentEmailAssignment {
    id: string;
    agentId: string;
    emailAddressId: string;
    address: string | null;
    direction: 'outbound' | 'inbound';
    priority: number;
    dispatchMode: 'task-spawn' | 'conversation';
    createdAt: string;
}

/** AW-05 — a per-Agent inbox settings patch. Ceilings: null = inherit, 0 = no limit. */
export interface AgentInboxSettingsInput {
    mode?: AgentInboxMode;
    emailAddressId?: string | null;
    dailySendCap?: number | null;
    burstSendCap?: number | null;
    recipientBurstCap?: number | null;
    recipientsPerMessageCap?: number | null;
}

export interface EmailDraftDecision {
    id: string;
    status: EmailMessageStatus | null;
    approvedById: string | null;
    approvedAt: string | null;
    sentAt: string | null;
    failureReason: string | null;
}

export interface EmailMessageDetail extends EmailMessageListItem {
    ccAddresses: string[] | null;
    bccAddresses: string[] | null;
    bodyText: string;
    bodyHtml: string | null;
    agentId: string | null;
    taskId: string | null;
    conversationId: string | null;
    providerMessageId: string | null;
}

export const emailAddressesAPI = {
    list: async (direction?: EmailAddressDirection) => {
        const query = direction ? `?direction=${direction}` : '';
        const data = await serverFetch<{ addresses: EmailAddress[] }>(`/email/addresses${query}`);
        return data.addresses;
    },
    create: async (input: CreateEmailAddressDto) => {
        const data = await serverMutation<{ address: EmailAddress }>({
            method: 'POST',
            endpoint: '/email/addresses',
            data: input,
            wrapInData: false,
        });
        return data.address;
    },
    update: async (id: string, input: Partial<CreateEmailAddressDto> & { disabled?: boolean }) => {
        const data = await serverMutation<{ address: EmailAddress }>({
            method: 'PATCH',
            endpoint: `/email/addresses/${id}`,
            data: input,
            wrapInData: false,
        });
        return data.address;
    },
    remove: async (id: string) => {
        await serverMutation<void>({
            method: 'DELETE',
            endpoint: `/email/addresses/${id}`,
            data: {},
            wrapInData: false,
        });
    },
    triggerVerification: async (id: string) => {
        const data = await serverMutation<{ messageRef: string }>({
            method: 'POST',
            endpoint: `/email/addresses/${id}/verify`,
            data: {},
            wrapInData: false,
        });
        return data;
    },
    listMessagesForAgent: async (agentId: string, limit = 50, offset = 0) => {
        const data = await serverFetch<{ messages: EmailMessageListItem[] }>(
            `/email/messages?agentId=${agentId}&limit=${limit}&offset=${offset}`,
        );
        return data.messages;
    },
    getMessage: async (id: string) => {
        const data = await serverFetch<{ message: EmailMessageDetail }>(`/email/messages/${id}`);
        return data.message;
    },
    sendMessage: async (input: {
        agentId: string;
        to: string[];
        subject: string;
        bodyText: string;
        cc?: string[];
        bodyHtml?: string;
        fromAddressId?: string;
    }) => {
        const data = await serverMutation<{
            result: { providerMessageId: string; accepted: string[]; rejected: unknown[] };
        }>({
            method: 'POST',
            endpoint: '/email/messages',
            data: input,
            wrapInData: false,
        });
        return data.result;
    },

    // ── Agent email (AW-05) ─────────────────────────────────────────
    getAgentSendPolicy: async (agentId: string) =>
        serverFetch<AgentEmailSendPolicyView>(
            `/email/agents/${encodeURIComponent(agentId)}/send-policy`,
        ),
    updateAgentInbox: async (agentId: string, input: AgentInboxSettingsInput) =>
        serverMutation<AgentEmailSendPolicyView & { inbox: AgentInboxDto; created: boolean }>({
            method: 'PUT',
            endpoint: `/email/agents/${encodeURIComponent(agentId)}/inbox`,
            data: input,
            wrapInData: false,
        }),
    approveDraft: async (messageId: string) =>
        serverMutation<{ message: EmailDraftDecision }>({
            method: 'POST',
            endpoint: `/email/messages/${encodeURIComponent(messageId)}/approve`,
            data: {},
            wrapInData: false,
        }),
    discardDraft: async (messageId: string) =>
        serverMutation<{ message: EmailDraftDecision }>({
            method: 'POST',
            endpoint: `/email/messages/${encodeURIComponent(messageId)}/discard`,
            data: {},
            wrapInData: false,
        }),
    listAgentAssignments: async (agentId: string) => {
        const data = await serverFetch<{ assignments: AgentEmailAssignment[] }>(
            `/email/agents/${encodeURIComponent(agentId)}/assignments`,
        );
        return data.assignments;
    },
    createAgentAssignment: async (
        agentId: string,
        input: { emailAddressId: string; direction: 'outbound' | 'inbound' },
    ) => {
        const data = await serverMutation<{ assignment: AgentEmailAssignment }>({
            method: 'POST',
            endpoint: `/email/agents/${encodeURIComponent(agentId)}/assignments`,
            data: input,
            wrapInData: false,
        });
        return data.assignment;
    },
    removeAgentAssignment: async (assignmentId: string) => {
        await serverMutation<void>({
            method: 'DELETE',
            endpoint: `/email/assignments/${encodeURIComponent(assignmentId)}`,
            data: {},
            wrapInData: false,
        });
    },
};
