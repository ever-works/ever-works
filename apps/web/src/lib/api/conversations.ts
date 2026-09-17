import 'server-only';
import type {
    ConversationAttachmentRef,
    ConversationContextType,
    ConversationKind,
    ConversationMentionCandidate,
    ConversationMessageView,
    ConversationParticipantView,
    ConversationSendResult,
    ConversationSummaryView,
    ConversationTitleSource,
} from '@ever-works/contracts';
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

export interface NamedConversationListFilters {
    limit?: number;
    offset?: number;
    kind?: ConversationKind;
    agentId?: string;
    contextType?: ConversationContextType;
    contextId?: string;
}

export interface CreateNamedConversationInput {
    agentId: string;
    title?: string;
    contextType?: ConversationContextType;
    contextId?: string;
}

export interface SendNamedConversationMessageInput {
    body: string;
    clientMessageId?: string;
    attachments?: ConversationAttachmentRef[];
    model?: string;
}

/** The row `POST /conversations` returns for a named Conversation. */
export interface NamedConversationRow {
    id: string;
    kind: ConversationKind;
    agentId: string | null;
    title?: string | null;
    titleSource?: ConversationTitleSource | null;
    contextType?: ConversationContextType | null;
    contextId?: string | null;
    createdAt: string;
    updatedAt: string;
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

    // ── Named Conversations with an Agent ──────────────────────────────
    // Every method below is additive: the assistant thread keeps using the
    // methods above, unchanged.

    /** One page of named Conversations, newest activity first, with unread counts. */
    listNamed: async (filters: NamedConversationListFilters) => {
        const params = new URLSearchParams();
        params.set('limit', String(filters.limit ?? 50));
        params.set('offset', String(filters.offset ?? 0));
        // `kind` always travels: it is what selects the named-list response.
        params.set('kind', filters.kind ?? 'direct');
        if (filters.agentId) params.set('agentId', filters.agentId);
        if (filters.contextType) params.set('contextType', filters.contextType);
        if (filters.contextId) params.set('contextId', filters.contextId);
        return serverFetch<{ conversations: ConversationSummaryView[]; total: number }>(
            `/conversations?${params.toString()}`,
        );
    },

    /** Open a Conversation addressed at one Agent, optionally about one object. */
    createNamed: async (data: CreateNamedConversationInput) => {
        return serverMutation<NamedConversationRow>({
            endpoint: '/conversations',
            data: { kind: 'direct', ...data },
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Set (`string`) or clear (`null`) the name a person gave a Conversation. */
    setName: async (id: string, name: string | null) => {
        return serverMutation<{
            id: string;
            title: string | null;
            titleSource: ConversationTitleSource | null;
        }>({
            endpoint: `/conversations/${id}/name`,
            data: { name },
            method: 'PUT',
            wrapInData: false,
        });
    },

    listMessages: async (id: string, options: { limit?: number; before?: string } = {}) => {
        const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
        if (options.before) params.set('before', options.before);
        return serverFetch<{ messages: ConversationMessageView[] }>(
            `/conversations/${id}/messages?${params.toString()}`,
        );
    },

    send: async (id: string, data: SendNamedConversationMessageInput) => {
        return serverMutation<ConversationSendResult>({
            endpoint: `/conversations/${id}/messages/send`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    retry: async (id: string, messageId: string) => {
        return serverMutation<ConversationSendResult>({
            endpoint: `/conversations/${id}/messages/${messageId}/retry`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    discard: async (id: string, messageId: string) => {
        return serverMutation<void>({
            endpoint: `/conversations/${id}/messages/${messageId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    markRead: async (id: string, lastReadMessageId: string) => {
        return serverMutation<void>({
            endpoint: `/conversations/${id}/read`,
            data: { lastReadMessageId },
            method: 'POST',
            wrapInData: false,
        });
    },

    mentionCandidates: async (query: string) => {
        return serverFetch<{ candidates: ConversationMentionCandidate[] }>(
            `/conversations/mention-candidates?q=${encodeURIComponent(query)}`,
        );
    },

    participants: async (id: string) => {
        return serverFetch<{ participants: ConversationParticipantView[] }>(
            `/conversations/${id}/participants`,
        );
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
