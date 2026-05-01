import 'server-only';
import type { UIMessage } from 'ai';
import { serverFetch } from '@/lib/api/server-api';

export interface MessageUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

export interface SaveMessagesOptions {
    conversationId: string;
    originalMessages: UIMessage[];
    allMessages: UIMessage[];
    model?: string;
    usage?: MessageUsage;
}

/**
 * Append only new messages to a conversation.
 * Compares original vs final messages by ID and persists the diff.
 */
export async function saveConversationMessages({
    conversationId,
    originalMessages,
    allMessages,
    model,
    usage,
}: SaveMessagesOptions): Promise<void> {
    const existingIds = new Set(originalMessages.map((m) => m.id));
    const newMessages = allMessages.filter(
        (m) => !existingIds.has(m.id) && !isProviderErrorMessage(m),
    );

    if (newMessages.length === 0) return;

    const serialized = newMessages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: extractTextContent(msg),
        parts: msg.parts,
        // Attach model/usage to assistant messages only
        ...(msg.role === 'assistant' && model ? { model } : {}),
        ...(msg.role === 'assistant' && usage ? { usage } : {}),
    }));

    await serverFetch(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ messages: serialized }),
    });
}

function extractTextContent(msg: UIMessage): string {
    return msg.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
}

function isProviderErrorMessage(msg: UIMessage): boolean {
    if (msg.role !== 'assistant') return false;

    const text = extractTextContent(msg).trim();
    return text.startsWith('**Error:**');
}
