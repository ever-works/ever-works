'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useChat, type UIMessage } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useTranslations } from 'next-intl';
import type { ProviderOption } from '@/lib/api/types-only';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import { toast } from 'sonner';

interface ChatContextValue {
    // Chat state from useChat
    messages: UIMessage[];
    setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
    status: 'submitted' | 'streaming' | 'ready' | 'error';
    error: Error | undefined;
    stop: () => void;
    regenerate: () => void;

    // Actions
    sendMessage: (text: string) => void;
    resetChat: () => void;

    // Provider selection
    providers: ProviderOption[];
    selectedProvider: string | null;
    setSelectedProvider: (id: string | null) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const t = useTranslations('dashboard.aiChat');
    const [providers, setProviders] = useState<ProviderOption[]>([]);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

    const welcomeMessage: UIMessage = {
        id: 'welcome',
        role: 'assistant',
        parts: [{ type: 'text', text: t('welcomeMessage') }],
    };

    const chat = useChat({
        messages: [welcomeMessage],
        transport: new DefaultChatTransport({
            api: '/api/chat',
            body: () => ({
                providerOverride: selectedProvider ?? 'openrouter',
            }),
        }),
    });

    // Fetch available AI providers on mount
    useEffect(() => {
        let cancelled = false;

        async function fetchProviders() {
            try {
                const result = await getGlobalFormSchema();
                if (cancelled) return;

                if (result.success && result.data) {
                    const aiProviders = result.data.providers.ai ?? [];
                    setProviders(aiProviders);

                    const defaultProvider = resolveEffectiveDefault(aiProviders);
                    if (defaultProvider) {
                        setSelectedProvider(defaultProvider.id);
                    }
                } else {
                    toast.error(t('providersError'));
                }
            } catch (error) {
                if (cancelled) return;
                console.error('Failed to load AI providers:', error);
                toast.error(t('providersError'));
            }
        }

        fetchProviders();

        return () => {
            cancelled = true;
        };
    }, [t]);

    const sendMessage = useCallback(
        (text: string) => {
            if (!text.trim()) return;
            chat.sendMessage(
                { text },
                {
                    body: {
                        providerOverride: selectedProvider ?? 'openrouter',
                    },
                },
            );
        },
        [chat.sendMessage, selectedProvider],
    );

    const resetChat = useCallback(() => {
        chat.setMessages([welcomeMessage]);
    }, [chat.setMessages]);

    const handleSetSelectedProvider = useCallback((id: string | null) => {
        setSelectedProvider(id);
    }, []);

    const value: ChatContextValue = {
        messages: chat.messages,
        setMessages: chat.setMessages,
        status: chat.status,
        error: chat.error,
        stop: chat.stop,
        regenerate: chat.regenerate,
        sendMessage,
        resetChat,
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
