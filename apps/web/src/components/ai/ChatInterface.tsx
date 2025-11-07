'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { useAIStream } from '@/lib/hooks/use-ai-stream';
import { useChatContext } from '@/components/ai/ChatProvider';
import { ChatMessage, generateMessageId } from '@/lib/hooks/use-chat-history';
import { ROUTES, routeWithParams } from '@/lib/constants';

export function ChatInterface() {
    const t = useTranslations('dashboard.aiChat');
    const {
        messages,
        error: historyError,
        isLoading,
        setMessages,
        ensureSessionId,
        markSessionId,
        loadHistory,
        resetHistory,
    } = useChatContext();

    const [input, setInput] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(historyError);

    const pendingMessageRef = useRef<string | null>(null);
    const endRef = useRef<HTMLDivElement | null>(null);

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
            if (chunk.metadata?.sessionId) {
                markSessionId(chunk.metadata.sessionId);
            }

            if (chunk.metadata?.error) {
                setErrorMessage(chunk.metadata.error);
            }

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
            if (error.message.toLowerCase().includes('404')) {
                markSessionId(null);
            }
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

        setMessages((prev) => [...prev, userMessage, assistantMessage]);
        scrollToBottom('auto');

        const activeSessionId = ensureSessionId();

        const endpoint = routeWithParams(ROUTES.API_AI_CONVERSATIONS_MESSAGE_STREAM, {
            sessionId: activeSessionId,
        });

        try {
            await streamMessage(endpoint, { message: trimmed });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to send message.';
            setErrorMessage(message);
            updatePendingMessage((current) => ({
                ...current,
                isStreaming: false,
                error: message,
            }));
            if (message.toLowerCase().includes('404')) {
                markSessionId(null);
            }
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
            <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border dark:border-border-dark">
                <div>
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
                        'text-xs font-medium text-primary',
                        'hover:text-primary-hover',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                >
                    {t('newChat')}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
                {isLoading && messages.length === 0 ? (
                    <div className="flex h-full min-h-[120px] items-center justify-center text-xs text-text-muted dark:text-text-muted-dark">
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
                                            ? 'bg-primary text-white'
                                            : 'bg-surface-tertiary dark:bg-surface-tertiary-dark text-text dark:text-text-dark',
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
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        placeholder={t('inputPlaceholder')}
                        className={cn(
                            'flex-1 px-3 py-2 text-sm rounded-lg transition-colors',
                            'bg-surface-tertiary dark:bg-surface-tertiary-dark',
                            'border border-border dark:border-border-dark',
                            'text-text dark:text-text-dark',
                            'placeholder-text-muted dark:placeholder-text-muted-dark',
                            'focus:outline-none focus:border-primary',
                        )}
                        disabled={isStreaming}
                        autoComplete="off"
                    />
                    <button
                        type="submit"
                        disabled={!input.trim() || isStreaming}
                        className={cn(
                            'px-3 py-2 rounded-lg transition-colors',
                            'bg-primary hover:bg-primary-hover text-white',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                            />
                        </svg>
                    </button>
                </div>
            </form>
        </div>
    );
}
