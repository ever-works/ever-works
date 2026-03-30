'use client';

import {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    useRef,
    useMemo,
} from 'react';
import { useChat, type UIMessage } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import type { ProviderOption } from '@/lib/api/types-only';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import { toast } from 'sonner';
import { DEFAULT_AI_PROVIDER } from '@/lib/constants';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';

import type { ConversationSummary } from '@/lib/api/conversations';
import {
    listConversations,
    getConversation,
    createConversation,
    deleteConversation,
} from '@/app/actions/dashboard/conversations';

const ACTIVE_CONVERSATION_KEY = 'chat-active-conversation';
interface ChatContextValue {
    messages: UIMessage[];
    setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
    status: 'submitted' | 'streaming' | 'ready' | 'error';
    error: Error | undefined;
    stop: () => void;
    regenerate: () => void;
    sendMessage: (text: string) => void;
    resetChat: () => void;
    providers: ProviderOption[];
    selectedProvider: string;
    setSelectedProvider: (id: string) => void;
    conversationId: string | null;
    conversations: ConversationSummary[];
    conversationsLoading: boolean;
    loadConversation: (id: string) => Promise<void>;
    deleteConv: (id: string) => Promise<void>;
    refreshConversations: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

// Stable transport — created once outside the component
const transport = new DefaultChatTransport({ api: '/api/chat' });

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const t = useTranslations('dashboard.aiChat');
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);
    pathnameRef.current = pathname;
    const [providers, setProviders] = useState<ProviderOption[]>([]);
    const [selectedProvider, setSelectedProvider] = useLocalStorage<string>(
        'chat-ai-provider',
        DEFAULT_AI_PROVIDER,
    );
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [conversationsLoading, setConversationsLoading] = useState(false);
    const [persistedConvId, setPersistedConvId] = useLocalStorage<string>(
        ACTIVE_CONVERSATION_KEY,
        '',
    );
    const [conversationId, setConversationId] = useState<string | null>(persistedConvId || null);

    const conversationIdRef = useRef<string | null>(persistedConvId || null);
    const selectedProviderRef = useRef(selectedProvider);
    selectedProviderRef.current = selectedProvider;

    const chat = useChat({ id: 'ever-works-chat', transport });

    const chatRef = useRef(chat);
    chatRef.current = chat;

    // Restore active conversation on mount if messages are empty
    const hasRestoredRef = useRef(false);
    useEffect(() => {
        if (hasRestoredRef.current) return;
        hasRestoredRef.current = true;

        const id = conversationIdRef.current;
        if (!id || chatRef.current.messages.length > 0) return;

        getConversation(id)
            .then((conv) => {
                const uiMessages: UIMessage[] = conv.messages
                    .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
                    .map((msg) => ({
                        id: msg.id,
                        role: msg.role as 'user' | 'assistant',
                        parts: (msg.parts as UIMessage['parts']) ?? [
                            { type: 'text' as const, text: msg.content },
                        ],
                    }));
                chatRef.current.setMessages(uiMessages);
            })
            .catch(() => {
                // Conversation may have been deleted
                conversationIdRef.current = null;
                setConversationId(null);
                setPersistedConvId('');
            });
    }, [setPersistedConvId]);

    // Fetch providers on mount
    useEffect(() => {
        let cancelled = false;
        async function fetchProviders() {
            try {
                const result = await getGlobalFormSchema();
                if (cancelled) return;
                if (result.success && result.data) {
                    const aiProviders = result.data.providers.ai ?? [];
                    setProviders(aiProviders);
                    // Only set default if no persisted selection or persisted one doesn't exist
                    const persisted = selectedProviderRef.current;
                    const persistedExists =
                        persisted && aiProviders.some((p) => p.id === persisted && p.configured);
                    if (!persistedExists) {
                        const defaultProvider = resolveEffectiveDefault(aiProviders);
                        if (defaultProvider) setSelectedProvider(defaultProvider.id);
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

    const updateConversationId = useCallback(
        (id: string | null) => {
            conversationIdRef.current = id;
            setConversationId(id);
            setPersistedConvId(id ?? '');
        },
        [setPersistedConvId],
    );

    const refreshConversations = useCallback(async () => {
        setConversationsLoading(true);
        try {
            const result = await listConversations(50, 0);
            setConversations(result.conversations);
        } catch {
            // Silent fail
        } finally {
            setConversationsLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshConversations();
    }, [refreshConversations]);

    const sendMessage = useCallback(
        async (text: string) => {
            if (!text.trim()) return;

            if (!conversationIdRef.current) {
                try {
                    const title = text.length <= 60 ? text : text.substring(0, 57) + '...';
                    const conv = await createConversation(selectedProviderRef.current, title);
                    updateConversationId(conv.id);
                } catch {
                    toast.error(t('errors.unableToSend'));
                    return;
                }
            }

            chatRef.current.sendMessage(
                { text },
                {
                    body: {
                        providerOverride: selectedProviderRef.current,
                        conversationId: conversationIdRef.current,
                        currentPageUrl: pathnameRef.current,
                    },
                },
            );
        },
        [t],
    );

    const resetChat = useCallback(() => {
        chatRef.current.setMessages([]);
        updateConversationId(null);
        refreshConversations();
    }, [refreshConversations, updateConversationId]);

    const loadConversation = useCallback(
        async (id: string) => {
            try {
                const conv = await getConversation(id);
                updateConversationId(conv.id);

                const uiMessages: UIMessage[] = conv.messages
                    .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
                    .map((msg) => ({
                        id: msg.id,
                        role: msg.role as 'user' | 'assistant',
                        parts: (msg.parts as UIMessage['parts']) ?? [
                            { type: 'text' as const, text: msg.content },
                        ],
                    }));

                chatRef.current.setMessages(uiMessages);
            } catch {
                toast.error(t('errors.unableToSend'));
            }
        },
        [t, updateConversationId],
    );

    const deleteConv = useCallback(
        async (id: string) => {
            try {
                await deleteConversation(id);
                setConversations((prev) => prev.filter((c) => c.id !== id));
                if (conversationIdRef.current === id) {
                    chatRef.current.setMessages([]);
                    updateConversationId(null);
                }
            } catch {
                toast.error(t('errors.unableToSend'));
            }
        },
        [t, updateConversationId],
    );

    const handleSetSelectedProvider = useCallback(
        (id: string) => setSelectedProvider(id),
        [setSelectedProvider],
    );

    const value: ChatContextValue = useMemo(
        () => ({
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
            conversationId,
            conversations,
            conversationsLoading,
            loadConversation,
            deleteConv,
            refreshConversations,
        }),
        [
            chat.messages,
            chat.setMessages,
            chat.status,
            chat.error,
            chat.stop,
            chat.regenerate,
            sendMessage,
            resetChat,
            providers,
            selectedProvider,
            handleSetSelectedProvider,
            conversationId,
            conversations,
            conversationsLoading,
            loadConversation,
            deleteConv,
            refreshConversations,
        ],
    );

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
    const context = useContext(ChatContext);
    if (!context) throw new Error('useChatContext must be used within a ChatProvider');
    return context;
}
