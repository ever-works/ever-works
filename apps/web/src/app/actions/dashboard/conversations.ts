'use server';

import {
    conversationsAPI,
    type ConversationSummary,
    type ConversationDetail,
} from '@/lib/api/conversations';

export async function listConversations(
    limit = 50,
    offset = 0,
): Promise<{ conversations: ConversationSummary[]; total: number }> {
    return conversationsAPI.list(limit, offset);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
    return conversationsAPI.get(id);
}

export async function createConversation(
    providerId?: string,
    title?: string,
): Promise<ConversationSummary> {
    return conversationsAPI.create({ providerId, title });
}

export async function deleteConversation(id: string): Promise<void> {
    await conversationsAPI.delete(id);
}

export async function deleteAllConversations(): Promise<{ deleted: number }> {
    return conversationsAPI.deleteAll();
}
