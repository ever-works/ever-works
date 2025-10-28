'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { loadLatestConversation } from '@/app/actions/ai-conversations';
import type { ConversationMessage } from '@/lib/api';

export type ChatMessage = ConversationMessage & {
    id: string;
    isStreaming?: boolean;
    metadata?: Record<string, any>;
    error?: string;
};

export interface UseChatHistoryValue {
    sessionId: string | null;
    messages: ChatMessage[];
    error: string | null;
    isLoading: boolean;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    ensureSessionId: () => string;
    markSessionId: (id: string | null) => void;
    loadHistory: () => Promise<void>;
    resetHistory: () => void;
}

const INITIAL_ASSISTANT_MESSAGE =
    'Hi! I can help you create directories using natural language. Ask something like "Create a directory for AI tools" or describe what you need.';

const generateMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
export const generateSessionId = () =>
    `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const createInitialMessages = (): ChatMessage[] => [
    {
        id: generateMessageId(),
        role: 'assistant',
        content: INITIAL_ASSISTANT_MESSAGE,
        timestamp: new Date().toISOString(),
    },
];

const normalizeRole = (role?: string): ChatMessage['role'] => {
    switch ((role || '').toLowerCase()) {
        case 'user':
        case 'human':
            return 'user';
        case 'assistant':
        case 'ai':
            return 'assistant';
        case 'system':
            return 'system';
        case 'tool':
            return 'tool';
        case 'function':
            return 'function';
        default:
            return 'assistant';
    }
};

const safeDateString = (value: string | null | undefined): string => {
    if (!value) {
        return new Date().toISOString();
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return new Date().toISOString();
    }

    return parsed.toISOString();
};

const mapHistoryMessages = (sessionId: string, messages: ConversationMessage[]): ChatMessage[] => {
    if (!messages.length) {
        return createInitialMessages();
    }

    return messages
        .map((message, index) => ({
            id: `${sessionId}-${message.timestamp || index}-${index}`,
            role: normalizeRole(message.role),
            content: message.content,
            timestamp: safeDateString(message.timestamp),
        }))
        .filter((message) => message.content.trim().length > 0);
};

export function useChatHistory(): UseChatHistoryValue {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const hasLoadedRef = useRef(false);

    const ensureSession = useCallback(() => {
        if (sessionId) {
            return sessionId;
        }

        const next = generateSessionId();
        setSessionId(next);
        return next;
    }, [sessionId]);

    const markSessionId = useCallback((id: string | null) => {
        setSessionId(id);
    }, []);

    const resetHistory = useCallback(() => {
        setMessages(createInitialMessages());
        setSessionId(null);
        setError(null);
        hasLoadedRef.current = false;
        setIsLoading(false);
    }, []);

    const loadHistory = useCallback(async () => {
        if (hasLoadedRef.current) {
            return;
        }

        hasLoadedRef.current = true;
        setIsLoading(true);

        try {
            const result = await loadLatestConversation();
            if (!result) {
                setMessages(createInitialMessages());
                return;
            }

            if ('error' in result) {
                setError(result.error);
                return;
            }

            const normalizedMessages = mapHistoryMessages(result.sessionId, result.messages ?? []);
            setSessionId(result.sessionId);
            setMessages(normalizedMessages.length ? normalizedMessages : createInitialMessages());
            setError(null);
        } catch (err) {
            console.error('Failed to load chat history:', err);
            setError(
                err instanceof Error
                    ? err.message
                    : 'Failed to load latest conversation. Please try again.',
            );
        } finally {
            setIsLoading(false);
        }
    }, []);

    return useMemo(
        () => ({
            sessionId,
            messages,
            error,
            isLoading,
            setMessages,
            ensureSessionId: ensureSession,
            markSessionId,
            loadHistory,
            resetHistory,
        }),
        [
            sessionId,
            messages,
            error,
            isLoading,
            ensureSession,
            markSessionId,
            loadHistory,
            resetHistory,
        ],
    );
}
