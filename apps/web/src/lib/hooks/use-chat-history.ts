'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

export type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'function';

export type ChatMessage = {
    id: string;
    role: ChatMessageRole;
    content: string;
    timestamp: string | null;
    isStreaming?: boolean;
    metadata?: Record<string, any>;
    error?: string;
};

export interface UseChatHistoryValue {
    messages: ChatMessage[];
    error: string | null;
    isLoading: boolean;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    loadHistory: () => void;
    resetHistory: () => void;
}

const INITIAL_ASSISTANT_MESSAGE =
    'Hi! I can help you create directories using natural language. Ask something like "Create a directory for AI tools" or describe what you need.';

export const generateMessageId = () =>
    `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const createInitialMessages = (): ChatMessage[] => [
    {
        id: generateMessageId(),
        role: 'assistant',
        content: INITIAL_ASSISTANT_MESSAGE,
        timestamp: new Date().toISOString(),
    },
];

export function useChatHistory(): UseChatHistoryValue {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const hasLoadedRef = useRef(false);

    const resetHistory = useCallback(() => {
        setMessages(createInitialMessages());
        setError(null);
        hasLoadedRef.current = false;
        setIsLoading(false);
    }, []);

    const loadHistory = useCallback(() => {
        if (hasLoadedRef.current) {
            return;
        }

        hasLoadedRef.current = true;
        setMessages(createInitialMessages());
        setIsLoading(false);
    }, []);

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
