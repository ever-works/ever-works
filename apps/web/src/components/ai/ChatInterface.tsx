'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { useAIStream } from '@/lib/hooks/use-ai-stream';
import { useChatContext } from '@/components/ai/ChatProvider';
import { ChatMessage, generateMessageId } from '@/lib/hooks/use-chat-history';
import { ROUTES } from '@/lib/constants';
import { SendHorizonal } from 'lucide-react';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { Tooltip } from '@/components/ui/tooltip';

export function ChatInterface() {
    const t = useTranslations('dashboard.aiChat');
    const {
        messages,
        error: historyError,
        isLoading,
        setMessages,
        loadHistory,
        resetHistory,
        providers,
        selectedProvider,
        setSelectedProvider,
    } = useChatContext();

    const [input, setInput] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(historyError);

    const pendingMessageRef = useRef<string | null>(null);
    const endRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const autoResize = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };

    useEffect(() => {
        loadHistory();
    }, [loadHistory]);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        if (!endRef.current) return;
        requestAnimationFrame(() => {
            endRef.current?.scrollIntoView({ behavior, block: 'end' });
        });
    }, []);

    useEffect(() => {
        if (messages.length) {
            scrollToBottom('auto');
        }
    }, [messages, scrollToBottom]);

    useEffect(() => {
        if (historyError) {
            setErrorMessage(historyError);
        }
    }, [historyError]);

    const updatePendingMessage = useCallback(
        (updater: (message: ChatMessage) => ChatMessage) => {
            const pendingId = pendingMessageRef.current;
            if (!pendingId) return;
            setMessages((prev) =>
                prev.map((message) => (message.id === pendingId ? updater(message) : message)),
            );
        },
        [setMessages],
    );

    const clearPending = useCallback(() => {
        pendingMessageRef.current = null;
    }, []);

    const { streamMessage, isStreaming, reset } = useAIStream({
        onChunk: (chunk) => {
            updatePendingMessage((message) => ({
                ...message,
                content: chunk.content ? message.content + chunk.content : message.content,
                isStreaming: !chunk.done,
                metadata: { ...message.metadata, ...chunk.metadata },
                error: chunk.metadata?.error ?? message.error,
            }));

            if (chunk.done) {
                clearPending();
            }
        },
        onComplete: () => {
            updatePendingMessage((message) => ({
                ...message,
                isStreaming: false,
            }));
            clearPending();
        },
        onError: (error) => {
            setErrorMessage(error.message);
            updatePendingMessage((message) => ({
                ...message,
                isStreaming: false,
                error: error.message,
            }));
            clearPending();
        },
    });

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = input.trim();
        if (!trimmed || isStreaming) return;

        setInput('');
        setErrorMessage(null);

        const now = new Date().toISOString();

        const userMessage: ChatMessage = {
            id: generateMessageId(),
            role: 'user',
            content: trimmed,
            timestamp: now,
        };

        const assistantMessage: ChatMessage = {
            id: generateMessageId(),
            role: 'assistant',
            content: '',
            timestamp: now,
            isStreaming: true,
        };

        pendingMessageRef.current = assistantMessage.id;

        const updatedMessages = [...messages, userMessage, assistantMessage];
        setMessages(updatedMessages);
        scrollToBottom('auto');

        // Build the message history to send (exclude the empty assistant placeholder)
        const chatHistory = updatedMessages
            .filter((m) => m.content.trim().length > 0)
            .map((m) => ({ role: m.role, content: m.content }));

        try {
            await streamMessage(ROUTES.API_AI_CONVERSATIONS_CHAT_STREAM, {
                messages: chatHistory,
                providerOverride: selectedProvider ?? undefined,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : t('errors.unableToSend');
            setErrorMessage(message);
            updatePendingMessage((current) => ({
                ...current,
                isStreaming: false,
                error: message,
            }));
            clearPending();
        }
    };

    const handleResetConversation = () => {
        if (isStreaming) return;
        reset();
        resetHistory();
        setErrorMessage(null);
        clearPending();
    };

    const formatTimestamp = useCallback((timestamp: string | null) => {
        if (!timestamp) return '';
        try {
            return new Date(timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch {
            return '';
        }
    }, []);

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="px-4 py-3 border-b border-border dark:border-border-dark space-y-2">
                <div className="flex items-start justify-between gap-3">
                    <div className="w-2/3">
                        <h2 className="text-base font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('subtitle')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleResetConversation}
                        disabled={isStreaming}
                        className={cn(
                            'text-xs cursor-pointer font-medium text-primary',
                            'hover:text-primary-hover',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                            'border border-primary-hover rounded-full px-1.5 py-0.5 transition-colors',
                            'bg-primary-hover/10',
                        )}
                    >
                        {`+ ${t('newChat')}`}
                    </button>
                </div>

                {providers.length > 1 && (
                    <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {providers.map((provider) => {
                            const isActive = selectedProvider === provider.id;
                            const button = (
                                <button
                                    key={provider.id}
                                    type="button"
                                    onClick={() => setSelectedProvider(provider.id)}
                                    disabled={!provider.configured || isStreaming}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors border shrink-0',
                                        isActive
                                            ? 'border-primary bg-primary/10 text-primary'
                                            : 'border-border dark:border-border-dark hover:border-primary/50 text-text-secondary dark:text-text-secondary-dark',
                                        !provider.configured && 'opacity-40 cursor-not-allowed',
                                        isStreaming && 'opacity-50 cursor-not-allowed',
                                    )}
                                >
                                    {provider.icon && (
                                        <PluginIcon
                                            icon={provider.icon}
                                            name={provider.name}
                                            size={16}
                                        />
                                    )}
                                    <span>{provider.name}</span>
                                    {isActive && (
                                        <svg
                                            className="w-3 h-3 text-primary"
                                            fill="currentColor"
                                            viewBox="0 0 20 20"
                                        >
                                            <path
                                                fillRule="evenodd"
                                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                                clipRule="evenodd"
                                            />
                                        </svg>
                                    )}
                                </button>
                            );

                            return !provider.configured ? (
                                <Tooltip key={provider.id} content={t('providerNotConfigured')}>
                                    {button}
                                </Tooltip>
                            ) : (
                                <span key={provider.id}>{button}</span>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
                {isLoading && messages.length === 0 ? (
                    <div className="flex h-full min-h-30 items-center justify-center text-xs text-text-muted dark:text-text-muted-dark">
                        {t('loadingConversation')}
                    </div>
                ) : (
                    messages.map((message) => {
                        const isUser = message.role === 'user';
                        return (
                            <div
                                key={message.id}
                                className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
                            >
                                <div
                                    className={cn(
                                        'max-w-[90%] rounded-lg px-3 py-2 motion-safe:animate-fade-in',
                                        isUser
                                            ? 'bg-brand-purple dark:bg-brand-purple/10 text-white'
                                            : 'bg-surface-tertiary dark:bg-surface-tertiary-dark/50 text-text dark:text-text-dark',
                                        message.error &&
                                            'border border-danger/60 text-danger dark:text-danger',
                                    )}
                                >
                                    {message.content && (
                                        <p className="text-xs leading-relaxed whitespace-pre-wrap">
                                            {message.content}
                                        </p>
                                    )}

                                    {message.isStreaming && !message.content && (
                                        <div className="flex space-x-1 py-1">
                                            <span className="w-1.5 h-1.5 bg-text-muted dark:bg-text-muted-dark rounded-full animate-bounce" />
                                            <span
                                                className="w-1.5 h-1.5 bg-text-muted dark:bg-text-muted-dark rounded-full animate-bounce"
                                                style={{ animationDelay: '150ms' }}
                                            />
                                            <span
                                                className="w-1.5 h-1.5 bg-text-muted dark:bg-text-muted-dark rounded-full animate-bounce"
                                                style={{ animationDelay: '300ms' }}
                                            />
                                        </div>
                                    )}

                                    {message.error && (
                                        <p className="text-[11px] mt-1 text-danger">
                                            {message.error}
                                        </p>
                                    )}

                                    <p
                                        className={cn(
                                            'text-[10px] mt-1',
                                            isUser
                                                ? 'text-white/70'
                                                : 'text-text-muted dark:text-text-muted-dark',
                                        )}
                                    >
                                        {formatTimestamp(message.timestamp)}
                                    </p>
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={endRef} />
            </div>

            {errorMessage && <div className="px-4 pb-1 text-xs text-danger">{errorMessage}</div>}

            <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2 shrink-0">
                <div
                    className={cn(
                        'relative flex flex-col rounded-xl border transition-colors',
                        'bg-white dark:bg-surface-dark',
                        'border-border dark:border-white/10',
                        'focus-within:border-primary/40 dark:focus-within:border-white/20',
                        'shadow-sm',
                    )}
                >
                    <textarea
                        ref={textareaRef}
                        value={input}
                        rows={1}
                        onChange={(e) => {
                            setInput(e.target.value);
                            autoResize();
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (input.trim() && !isStreaming && !e.currentTarget.disabled) {
                                    e.currentTarget.form?.requestSubmit();
                                }
                            }
                        }}
                        placeholder={t('inputPlaceholder')}
                        className={cn(
                            'w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm',
                            'text-text dark:text-white',
                            'placeholder:text-xs placeholder:text-text-muted dark:placeholder:text-white/30',
                            'focus:outline-none',
                            'max-h-40 overflow-y-auto',
                        )}
                        disabled={isStreaming}
                        autoComplete="off"
                    />
                    <div className="flex items-center justify-end px-3 pb-2.5 pt-1">
                        <button
                            type="submit"
                            disabled={!input.trim() || isStreaming}
                            className={cn(
                                'flex cursor-pointer items-center justify-center w-7 h-7 rounded-lg transition-all duration-200',
                                input.trim() && !isStreaming
                                    ? 'bg-primary-hover dark:bg-white/15 text-white hover:bg-primary-hover/80 dark:hover:bg-white/25'
                                    : 'bg-surface-tertiary dark:bg-white/5 text-text-muted dark:text-white/20 cursor-not-allowed',
                            )}
                        >
                            <SendHorizonal className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
                <p className="mt-1.5 text-center text-[10px] text-text-muted dark:text-white/25 select-none">
                    Enter to send · Shift+Enter for new line
                </p>
            </form>
        </div>
    );
}
