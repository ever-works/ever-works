'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'function';

export type ChatMessage = {
    id: string;
    role: ChatMessageRole;
    content: string;
    timestamp: string | null;
    // Whether the message was edited by the user after sending
    edited?: boolean;
    // When the message was edited (ISO string)
    editedTimestamp?: string | null;
    isStreaming?: boolean;
    metadata?: Record<string, any>;
    error?: string;
};

export interface UseChatHistoryOptions {
    initialMessage: string;
}

export interface UseChatHistoryValue {
    messages: ChatMessage[];
    error: string | null;
    isLoading: boolean;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    loadHistory: () => void;
    resetHistory: () => void;
}

export const generateMessageId = () =>
    `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const createInitialMessages = (initialMessage: string): ChatMessage[] => [
    {
        id: generateMessageId(),
        role: 'assistant',
        content: initialMessage,
        timestamp: new Date().toISOString(),
    },
];

export function useChatHistory({ initialMessage }: UseChatHistoryOptions): UseChatHistoryValue {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const hasLoadedRef = useRef(false);

    const resetHistory = useCallback(() => {
        setMessages(createInitialMessages(initialMessage));
        setError(null);
        hasLoadedRef.current = false;
        setIsLoading(false);
    }, [initialMessage]);

    const loadHistory = useCallback(() => {
        if (hasLoadedRef.current) {
            return;
        }

        hasLoadedRef.current = true;
        setMessages(createInitialMessages(initialMessage));
        setIsLoading(false);
    }, [initialMessage]);

    return useMemo(
        () => ({
            messages,
            error,
            isLoading,
            setMessages,
            loadHistory,
            resetHistory,
        }),
        [messages, error, isLoading, loadHistory, resetHistory],
    );
}
