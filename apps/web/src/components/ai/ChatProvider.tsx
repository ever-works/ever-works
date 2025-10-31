'use client';

import { createContext, useContext } from 'react';
import { useChatHistory, UseChatHistoryValue } from '@/lib/hooks/use-chat-history';

const ChatContext = createContext<UseChatHistoryValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const value = useChatHistory();

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): UseChatHistoryValue {
    const context = useContext(ChatContext);

    if (!context) {
        throw new Error('useChatContext must be used within a ChatProvider');
    }

    return context;
}
