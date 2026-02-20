'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useChatHistory, UseChatHistoryValue } from '@/lib/hooks/use-chat-history';
import type { ProviderOption } from '@/lib/api/types-only';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { resolveEffectiveDefault } from '@ever-works/plugin';

interface ChatContextValue extends UseChatHistoryValue {
    providers: ProviderOption[];
    selectedProvider: string | null;
    setSelectedProvider: (id: string | null) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const chatHistory = useChatHistory();
    const [providers, setProviders] = useState<ProviderOption[]>([]);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function fetchProviders() {
            const result = await getGlobalFormSchema();
            if (cancelled) return;

            if (result.success && result.data) {
                const aiProviders = result.data.providers.ai ?? [];
                setProviders(aiProviders);

                const defaultProvider = resolveEffectiveDefault(aiProviders);
                if (defaultProvider) {
                    setSelectedProvider(defaultProvider.id);
                }
            }
        }

        fetchProviders();

        return () => {
            cancelled = true;
        };
    }, []);

    const handleSetSelectedProvider = useCallback((id: string | null) => {
        setSelectedProvider(id);
    }, []);

    const value: ChatContextValue = {
        ...chatHistory,
        providers,
        selectedProvider,
        setSelectedProvider: handleSetSelectedProvider,
    };

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
    const context = useContext(ChatContext);

    if (!context) {
        throw new Error('useChatContext must be used within a ChatProvider');
    }

    return context;
}
