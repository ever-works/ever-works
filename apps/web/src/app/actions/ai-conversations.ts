'use server';

import { aiConversationAPI } from '@/lib/api';
import type { ConversationHistoryResponse, ConversationSummary } from '@/lib/api';

export type ConversationMessagePayload = ConversationHistoryResponse['messages'][number];

export interface ConversationLoadResult {
    sessionId: string;
    messages: ConversationMessagePayload[];
    metadata?: {
        title?: string | null;
        createdAt?: string | null;
        updatedAt?: string | null;
        messageCount?: number;
    };
}

export interface ConversationLoadError {
    error: string;
}

type ConversationLoadResponse = ConversationLoadResult | ConversationLoadError | null;

export async function loadLatestConversation(limit = 1): Promise<ConversationLoadResponse> {
    try {
        const conversations: ConversationSummary[] =
            await aiConversationAPI.getRecentConversations(limit);

        const latest = conversations[0];

        if (!latest) {
            return null;
        }

        const history: ConversationHistoryResponse = await aiConversationAPI.getConversationHistory(
            latest.sessionId,
        );

        return {
            sessionId: history.sessionId,
            messages: history.messages ?? [],
            metadata: {
                title: latest.title ?? null,
                createdAt: latest.createdAt ?? null,
                updatedAt: latest.updatedAt ?? null,
                messageCount: latest.messageCount,
            },
        };
    } catch (error) {
        console.error('Failed to load latest conversation:', error);
        return {
            error:
                error instanceof Error
                    ? error.message
                    : 'Failed to load latest conversation. Please try again later.',
        };
    }
}
