import 'server-only';
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
        const data = await serverFetch<{ addresses: EmailAddress[] }>({
            path: `/api/email/addresses${query}`,
        });
        return data.addresses;
    },
    create: async (input: CreateEmailAddressDto) => {
        const data = await serverMutation<{ address: EmailAddress }>({
            method: 'POST',
            path: '/api/email/addresses',
            body: input,
        });
        return data.address;
    },
    update: async (id: string, input: Partial<CreateEmailAddressDto> & { disabled?: boolean }) => {
        const data = await serverMutation<{ address: EmailAddress }>({
            method: 'PATCH',
            path: `/api/email/addresses/${id}`,
            body: input,
        });
        return data.address;
    },
    remove: async (id: string) => {
        await serverMutation<void>({ method: 'DELETE', path: `/api/email/addresses/${id}` });
    },
    triggerVerification: async (id: string) => {
        const data = await serverMutation<{ messageRef: string }>({
            method: 'POST',
            path: `/api/email/addresses/${id}/verify`,
            body: {},
        });
        return data;
    },
    listMessagesForAgent: async (agentId: string, limit = 50, offset = 0) => {
        const data = await serverFetch<{ messages: EmailMessageListItem[] }>({
            path: `/api/email/messages?agentId=${agentId}&limit=${limit}&offset=${offset}`,
        });
        return data.messages;
    },
    getMessage: async (id: string) => {
        const data = await serverFetch<{ message: EmailMessageDetail }>({
            path: `/api/email/messages/${id}`,
        });
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
            path: '/api/email/messages',
            body: input,
        });
        return data.result;
    },
};
