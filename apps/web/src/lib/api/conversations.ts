import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export interface ConversationSummary {
    id: string;
    title?: string;
    providerId?: string;
    model?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ConversationMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    parts?: unknown[];
    createdAt: string;
}

export interface ConversationDetail extends ConversationSummary {
    messages: ConversationMessage[];
}

export const conversationsAPI = {
    list: async (limit = 50, offset = 0) => {
        return serverFetch<{ conversations: ConversationSummary[]; total: number }>(
            `/conversations?limit=${limit}&offset=${offset}`,
        );
    },

    get: async (id: string) => {
        return serverFetch<ConversationDetail>(`/conversations/${id}`);
    },

    create: async (data: { title?: string; providerId?: string; model?: string }) => {
        return serverMutation<ConversationSummary>({
            endpoint: '/conversations',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateTitle: async (id: string, title: string) => {
        return serverMutation<void>({
            endpoint: `/conversations/${id}`,
            data: { title },
            method: 'PATCH',
            wrapInData: false,
        });
    },

    /**
     * Re-pin (or clear) the model for an existing conversation.
     *
     * An empty string is the clear signal — the API maps it to NULL, meaning
     * "resolve the provider's configured default". `providerId` is NOT
     * updatable: a conversation's provider is immutable after creation.
     */
    updateModel: async (id: string, model: string | null) => {
        return serverMutation<void>({
            endpoint: `/conversations/${id}`,
            data: { model: model ?? '' },
            method: 'PATCH',
            wrapInData: false,
        });
    },

    delete: async (id: string) => {
        return serverMutation<void>({
            endpoint: `/conversations/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    deleteAll: async () => {
        return serverMutation<{ deleted: number }>({
            endpoint: '/conversations',
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
