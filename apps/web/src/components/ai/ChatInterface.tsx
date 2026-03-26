'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { useChatContext } from './ChatProvider';
import { ChatMessage } from './ChatMessage';
import { ChatProviderSelector } from './ChatProviderSelector';
import { SendHorizonal } from 'lucide-react';

export function ChatInterface() {
    const t = useTranslations('dashboard.aiChat');
    const {
        messages,
        setMessages,
        status,
        error,
        sendMessage,
        resetChat,
        stop,
        regenerate,
        providers,
        selectedProvider,
        setSelectedProvider,
    } = useChatContext();

    const [input, setInput] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingContent, setEditingContent] = useState('');

    const endRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const isStreaming = status === 'streaming' || status === 'submitted';

    const autoResize = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        if (!endRef.current) return;
        requestAnimationFrame(() => {
            endRef.current?.scrollIntoView({ behavior, block: 'end' });
        });
    }, []);

    useEffect(() => {
        if (messages.length) scrollToBottom('auto');
    }, [messages, scrollToBottom]);

    // ─── Handlers ────────────────────────────────────────────────

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = input.trim();
        if (!trimmed || isStreaming) return;

        sendMessage(trimmed);
        setInput('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
    };

    const handleEditStart = useCallback(
        (id: string, content: string) => {
            if (isStreaming) return;
            setEditingId(id);
            setEditingContent(content);
        },
        [isStreaming],
    );

    const handleEditCancel = useCallback(() => {
        setEditingId(null);
        setEditingContent('');
    }, []);

    const handleEditSave = useCallback(() => {
        if (!editingId || !editingContent.trim() || isStreaming) return;
        const trimmed = editingContent.trim();
        const editIndex = messages.findIndex((m) => m.id === editingId);
        if (editIndex === -1) return;

        const updatedMessages = messages.slice(0, editIndex + 1);
        updatedMessages[editIndex] = {
            ...updatedMessages[editIndex],
            parts: [{ type: 'text', text: trimmed }],
        };

        setMessages(updatedMessages);
        setEditingId(null);
        setEditingContent('');
        regenerate();
    }, [editingId, editingContent, isStreaming, messages, setMessages, regenerate]);

    const handleResetConversation = () => {
        if (isStreaming) return;
        resetChat();
    };

    // ─── Render ──────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Header + provider selector */}
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

                <ChatProviderSelector
                    providers={providers}
                    selectedProvider={selectedProvider}
                    isStreaming={isStreaming}
                    onSelect={setSelectedProvider}
                />
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
                {messages.map((message, index) => (
                    <ChatMessage
                        key={message.id}
                        message={message}
                        isStreaming={isStreaming}
                        isLastMessage={index === messages.length - 1}
                        editingId={editingId}
                        editingContent={editingContent}
                        onEditStart={handleEditStart}
                        onEditCancel={handleEditCancel}
                        onEditSave={handleEditSave}
                        onEditChange={setEditingContent}
                    />
                ))}
                <div ref={endRef} />
            </div>

            {/* Error display */}
            {error && <div className="px-4 pb-1 text-xs text-danger">{error.message}</div>}

            {/* Input form */}
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
                                if (input.trim() && !isStreaming) {
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
                    <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
                        <span className="text-[10px] text-text-muted dark:text-white/25 select-none">
                            {t('sendHint')}
                        </span>
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
            </form>
        </div>
    );
}
