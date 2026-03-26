'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useChat, type UIMessage } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useTranslations } from 'next-intl';
import type { ProviderOption } from '@/lib/api/types-only';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import { toast } from 'sonner';
import type { ConversationSummary } from '@/lib/api/conversations';
import {
	listConversations,
	getConversation,
	createConversation,
	deleteConversation,
} from '@/app/actions/dashboard/conversations';

interface ChatContextValue {
	messages: UIMessage[];
	setMessages: (messages: UIMessage[] | ((messages: UIMessage[]) => UIMessage[])) => void;
	status: 'submitted' | 'streaming' | 'ready' | 'error';
	error: Error | undefined;
	stop: () => void;
	regenerate: () => void;
	sendMessage: (text: string) => void;
	resetChat: () => void;

	// Providers
	providers: ProviderOption[];
	selectedProvider: string | null;
	setSelectedProvider: (id: string | null) => void;

	// Conversations
	conversationId: string | null;
	conversations: ConversationSummary[];
	conversationsLoading: boolean;
	loadConversation: (id: string) => Promise<void>;
	deleteConv: (id: string) => Promise<void>;
	refreshConversations: () => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
	const t = useTranslations('dashboard.aiChat');
	const [providers, setProviders] = useState<ProviderOption[]>([]);
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [conversationsLoading, setConversationsLoading] = useState(false);
	const conversationIdRef = useRef<string | null>(null);
	const [conversationId, setConversationId] = useState<string | null>(null);

	const chat = useChat({
		transport: new DefaultChatTransport({
			api: '/api/chat',
			body: () => ({
				providerOverride: selectedProvider ?? 'openrouter',
				conversationId: conversationIdRef.current,
			}),
		}),
	});

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
					const defaultProvider = resolveEffectiveDefault(aiProviders);
					if (defaultProvider) setSelectedProvider(defaultProvider.id);
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
		return () => { cancelled = true; };
	}, [t]);

	// Fetch conversation history on mount
	const refreshConversations = useCallback(async () => {
		setConversationsLoading(true);
		try {
			const result = await listConversations(50, 0);
			setConversations(result.conversations);
		} catch {
			// Silent fail — conversations are non-critical
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

			// Create conversation on first message if none exists
			if (!conversationIdRef.current) {
				try {
					const conv = await createConversation(selectedProvider ?? 'openrouter');
					conversationIdRef.current = conv.id;
					setConversationId(conv.id);
				} catch {
					// Continue without persistence
				}
			}

			chat.sendMessage(
				{ text },
				{
					body: {
						providerOverride: selectedProvider ?? 'openrouter',
						conversationId: conversationIdRef.current,
					},
				},
			);
		},
		[chat.sendMessage, selectedProvider],
	);

	const resetChat = useCallback(() => {
		chat.setMessages([]);
		conversationIdRef.current = null;
		setConversationId(null);
		// Refresh list to show the conversation we just had
		refreshConversations();
	}, [chat.setMessages, refreshConversations]);

	const loadConversation = useCallback(
		async (id: string) => {
			try {
				const conv = await getConversation(id);
				conversationIdRef.current = conv.id;
				setConversationId(conv.id);

				const uiMessages: UIMessage[] = conv.messages.map((msg) => ({
					id: msg.id,
					role: msg.role as 'user' | 'assistant',
					parts: [{ type: 'text' as const, text: msg.content }],
				}));

				chat.setMessages(uiMessages);
			} catch {
				toast.error(t('errors.unableToSend'));
			}
		},
		[chat.setMessages, t],
	);

	const deleteConv = useCallback(
		async (id: string) => {
			try {
				await deleteConversation(id);
				setConversations((prev) => prev.filter((c) => c.id !== id));
				// If we deleted the active conversation, reset
				if (conversationIdRef.current === id) {
					chat.setMessages([]);
					conversationIdRef.current = null;
					setConversationId(null);
				}
			} catch {
				toast.error(t('errors.unableToSend'));
			}
		},
		[chat.setMessages, t],
	);

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
		setSelectedProvider: useCallback((id: string | null) => setSelectedProvider(id), []),
		conversationId,
		conversations,
		conversationsLoading,
		loadConversation,
		deleteConv,
		refreshConversations,
	};

	return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
	const context = useContext(ChatContext);
	if (!context) throw new Error('useChatContext must be used within a ChatProvider');
	return context;
}
