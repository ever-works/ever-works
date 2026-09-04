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
import {
    attachmentUploadIds,
    formatAttachmentsBlock,
    type ChatAttachmentRef,
} from '@/lib/ai/attachments';
import { toast } from 'sonner';
import { DEFAULT_AI_PROVIDER } from '@/lib/constants';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { applyBrowserWorkspaceScope } from '@/lib/api/browser-api';

import type { ConversationSummary } from '@/lib/api/conversations';
import {
    listConversations,
    getConversation,
    createConversation,
    deleteConversation,
    updateConversationModel,
} from '@/app/actions/dashboard/conversations';

const ACTIVE_CONVERSATION_KEY = 'chat-active-conversation';
interface ChatContextValue {
    messages: UIMessage[];
    setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
    status: 'submitted' | 'streaming' | 'ready' | 'error';
    error: Error | undefined;
    stop: () => void;
    regenerate: () => void;
    /**
     * `attachments` is optional so every existing caller (welcome
     * suggestions, tool-result confirm/cancel buttons) keeps compiling
     * unchanged — only the composer passes them.
     */
    sendMessage: (text: string, attachments?: ReadonlyArray<ChatAttachmentRef>) => void;
    resetChat: () => void;
    providers: ProviderOption[];
    selectedProvider: string;
    setSelectedProvider: (id: string) => void;
    /** Model pinned for the active thread, or `null` for the provider default. */
    selectedModel: string | null;
    setSelectedModel: (modelId: string | null) => void;
    conversationId: string | null;
    conversations: ConversationSummary[];
    conversationsLoading: boolean;
    loadConversation: (id: string) => Promise<void>;
    deleteConv: (id: string) => Promise<void>;
    refreshConversations: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

// Stable transport — created once outside the component.
//
// `prepareSendMessagesRequest` stamps the per-tab workspace selector on every
// send. This is NOT optional and it is NOT only about Organizations: the tool
// loop inside `/api/chat` reaches the platform through `serverFetch`, which
// derives its scope from this header and THROWS `Invalid workspace scope` when
// it is absent (`lib/api/server-api.ts` → `parseWorkspaceSelector`). Without it
// every data action the assistant attempts fails before a request leaves the
// web tier, in personal scope as well as org scope.
//
// The middleware cannot supply it — `proxy.ts`'s matcher deliberately excludes
// `/api`, so a BFF route only ever receives the selector when the client sends
// it. We re-derive from `window.location.pathname` per request, exactly as
// `browserApiFetch` does, so a second tab on another Organization cannot leak
// its scope into this one.
export function prepareChatRequest({
    id,
    messages,
    trigger,
    messageId,
    body,
    headers,
}: {
    id: string;
    messages: UIMessage[];
    trigger: 'submit-message' | 'regenerate-message';
    messageId: string | undefined;
    body?: Record<string, unknown>;
    headers?: HeadersInit;
}): { body: object; headers: Headers } {
    // `body` is ONLY the extra fields — the transport's `body` merged with the
    // per-call one. The SDK hands id/messages/trigger/messageId to this callback
    // as SEPARATE arguments, and when the callback returns a `body` the SDK
    // POSTs that object VERBATIM instead of re-adding them (it only re-adds them
    // on the no-callback path). So returning `body` alone sends a request with
    // no `messages`, and /api/chat's schema rejects it with 400 before any model
    // is reached — i.e. every send fails. Restate the four fields here.
    return {
        body: { ...(body ?? {}), id, messages, trigger, messageId },
        headers: applyBrowserWorkspaceScope(headers),
    };
}

// Exported only so a unit spec can pin that the transport is actually WIRED to
// `prepareChatRequest`. Testing the function alone would not catch someone
// dropping the option here, which is precisely the regression this fixes.
export const transport = new DefaultChatTransport({
    api: '/api/chat',
    prepareSendMessagesRequest: prepareChatRequest,
});

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const t = useTranslations('dashboard.aiChat');
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);
    const [providers, setProviders] = useState<ProviderOption[]>([]);
    const [selectedProvider, setSelectedProvider] = useLocalStorage<string>(
        'chat-ai-provider',
        DEFAULT_AI_PROVIDER,
    );
    // Seed for the NEXT thread only. Once a conversation exists, the pin lives
    // on the conversation row (see `handleSetSelectedModel`) — otherwise the
    // model a thread was built around would silently change the moment the
    // user picked a different one in some other thread, or opened the app on
    // another device. Empty string is the stored form of "provider default";
    // `useLocalStorage` has no null channel.
    const [seedModel, setSeedModel] = useLocalStorage<string>('chat-ai-model', '');
    // The pin for the thread currently open. Only meaningful while
    // `conversationId` is set; before the first message there is no row to
    // hold it, so the seed above stands in.
    const [threadModel, setThreadModel] = useState<string | null>(null);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [conversationsLoading, setConversationsLoading] = useState(false);
    const [persistedConvId, setPersistedConvId] = useLocalStorage<string>(
        ACTIVE_CONVERSATION_KEY,
        '',
    );
    const [conversationId, setConversationId] = useState<string | null>(persistedConvId || null);

    const conversationIdRef = useRef<string | null>(persistedConvId || null);
    const selectedProviderRef = useRef(selectedProvider);

    // Which model the composer is actually pinned to right now. A thread that
    // exists owns its pin; before that, the browser-level seed does. Derived
    // rather than stored so the two can never disagree.
    const selectedModel = conversationId ? threadModel : seedModel || null;
    const selectedModelRef = useRef(selectedModel);

    const chat = useChat({ id: 'ever-works-chat', transport });

    const chatRef = useRef(chat);

    // Keep the "latest value" refs current WITHOUT writing during render.
    // These four exist so the long-lived callbacks below (sendMessage, the
    // conversation loaders) can read today's value without taking it as a
    // dependency and re-creating themselves on every keystroke. Assigning
    // `.current` in the render body is what `react-hooks/refs` forbids — a
    // render may be thrown away or replayed, which would publish a value that
    // was never committed. Syncing here instead runs after every commit, so
    // the refs are up to date by the time any handler or effect can read
    // them, and every consumer below is exactly that. No dependency array on
    // purpose: "after every render" IS the contract.
    useEffect(() => {
        pathnameRef.current = pathname;
        selectedProviderRef.current = selectedProvider;
        selectedModelRef.current = selectedModel;
        chatRef.current = chat;
    });

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
                // Re-pin the panel to what this thread was actually built on.
                // Without it, a thread started on Anthropic silently continues
                // on whatever the browser last used — the conversation row
                // still says Anthropic while every new turn goes elsewhere.
                if (conv.providerId) setSelectedProvider(conv.providerId);
                setThreadModel(conv.model ?? null);
            })
            .catch(() => {
                // Conversation may have been deleted
                conversationIdRef.current = null;
                setConversationId(null);
                setPersistedConvId('');
            });
    }, [setPersistedConvId, setSelectedProvider]);

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
    }, [setSelectedProvider, t]);

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
        async (text: string, attachments?: ReadonlyArray<ChatAttachmentRef>) => {
            const refs = attachments ?? [];
            // A message carrying only files is legitimate — "here, look at
            // this" — so an empty string is allowed when attachments exist.
            if (!text.trim() && refs.length === 0) return;

            if (!conversationIdRef.current) {
                try {
                    // Title from the TEXT only. A conversation titled after a
                    // filename tells the user nothing useful in the history
                    // list, and the attachment block is machine-shaped.
                    const seed = text.trim() || refs[0]?.name || '';
                    const normalised = seed.replace(/\s+/g, ' ').trim();
                    const title =
                        normalised.length <= 60 ? normalised : normalised.substring(0, 57) + '...';
                    // The seed becomes the new thread's own pin, stamped on the
                    // row at creation so it survives a reload on any device.
                    const modelPin = selectedModelRef.current;
                    const conv = await createConversation(
                        selectedProviderRef.current,
                        title,
                        modelPin ?? undefined,
                    );
                    setThreadModel(modelPin);
                    updateConversationId(conv.id);
                } catch {
                    toast.error(t('errors.unableToSend'));
                    return;
                }
            }

            // The fenced block is what the MODEL sees; `attachmentIds` is
            // what the PLATFORM sees. Sending both means the server never
            // has to re-parse a model-facing string to recover ids — the
            // block can change wording freely without breaking tool calls.
            const body = text.trim() + formatAttachmentsBlock(refs);
            chatRef.current.sendMessage(
                { text: body },
                {
                    body: {
                        providerOverride: selectedProviderRef.current,
                        // Omitted (not sent as null) when unpinned: the route
                        // schema treats absence as "let the provider resolve
                        // its configured model", which is exactly the
                        // `'auto'` path the engine already understood.
                        ...(selectedModelRef.current ? { model: selectedModelRef.current } : {}),
                        conversationId: conversationIdRef.current,
                        currentPageUrl: pathnameRef.current,
                        attachmentIds: attachmentUploadIds(refs),
                    },
                },
            );
        },
        [t, updateConversationId],
    );

    const resetChat = useCallback(() => {
        chatRef.current.setMessages([]);
        // Carry the pin forward into the seed so "New chat" continues on the
        // model the user was just working with, instead of snapping back to
        // whatever the seed held before this thread was opened.
        setSeedModel(selectedModelRef.current ?? '');
        setThreadModel(null);
        updateConversationId(null);
        refreshConversations();
    }, [refreshConversations, setSeedModel, updateConversationId]);

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
                // Same re-pin as the mount restore: opening a thread from
                // History puts the panel back on that thread's provider and
                // model, so the next turn continues it rather than silently
                // switching vendors mid-conversation.
                if (conv.providerId) setSelectedProvider(conv.providerId);
                setThreadModel(conv.model ?? null);
            } catch {
                toast.error(t('errors.unableToSend'));
            }
        },
        [t, updateConversationId, setSelectedProvider],
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

    /**
     * Serialises model-pin writes so the row ends up on the LAST model the
     * user picked, not whichever PATCH the network happened to deliver last.
     *
     * Picking A then B fires two independent requests; if A lands second the
     * row keeps A, and re-opening the thread silently restores a model the
     * user already moved off. Chaining each write onto the previous one makes
     * server order match click order. Failures are swallowed into the chain so
     * one dropped request cannot stall every later write.
     */
    const modelWriteChainRef = useRef<Promise<unknown>>(Promise.resolve());
    const persistModelPin = useCallback((conversationId: string, modelId: string | null) => {
        modelWriteChainRef.current = modelWriteChainRef.current
            .catch(() => {})
            .then(() => updateConversationModel(conversationId, modelId))
            .catch(() => {
                // Best-effort durability: the pin still governs this session's
                // next turn, only its survival across a reload is lost. Not
                // worth a toast that interrupts a message being composed.
            });
    }, []);

    const handleSetSelectedProvider = useCallback(
        (id: string) => {
            if (id === selectedProviderRef.current) return;
            setSelectedProvider(id);
            // Model ids are provider-specific — `openai/gpt-5-mini` means
            // nothing to Anthropic. Keeping the old pin across a provider
            // switch would send an unroutable id; clearing falls back to the
            // new provider's own configured default, which always resolves.
            setThreadModel(null);
            setSeedModel('');
            if (conversationIdRef.current) {
                persistModelPin(conversationIdRef.current, null);
            }
        },
        [setSelectedProvider, setSeedModel, persistModelPin],
    );

    const handleSetSelectedModel = useCallback(
        (modelId: string | null) => {
            const conversationId = conversationIdRef.current;
            if (conversationId) {
                setThreadModel(modelId);
                persistModelPin(conversationId, modelId);
                return;
            }
            // No row yet — hold it in the browser seed until the first message
            // creates the conversation, which stamps it on the row.
            setSeedModel(modelId ?? '');
        },
        [setSeedModel, persistModelPin],
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
            selectedModel,
            setSelectedModel: handleSetSelectedModel,
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
            selectedModel,
            handleSetSelectedModel,
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

/**
 * Non-throwing variant. Returns `null` outside a ChatProvider so the
 * caller can short-circuit (e.g. previews / unit tests rendering a
 * dashboard component without the full layout wrapper). Use this in
 * pages that want to *optionally* drive the chat panel — anything
 * required to function (the ChatPanel itself, the input, the
 * history list) should keep using `useChatContext`.
 */
export function useChatContextOptional(): ChatContextValue | null {
    return useContext(ChatContext);
}
