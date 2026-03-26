'use client';

import { cn } from '@/lib/utils/cn';
import type { UIMessage } from '@ai-sdk/react';
import { ChatMessageContent } from './ChatMessageContent';
import { ChatMessageEdit } from './ChatMessageEdit';
import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ChatMessageProps {
    message: UIMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
    editingId: string | null;
    editingContent: string;
    onEditStart: (id: string, content: string) => void;
    onEditCancel: () => void;
    onEditSave: () => void;
    onEditChange: (content: string) => void;
}

export function ChatMessage({
    message,
    isStreaming,
    isLastMessage,
    editingId,
    editingContent,
    onEditStart,
    onEditCancel,
    onEditSave,
    onEditChange,
}: ChatMessageProps) {
    const t = useTranslations('dashboard.aiChat');
    const isUser = message.role === 'user';
    const isEditing = editingId === message.id;
    const isMessageStreaming = message.role === 'assistant' && isStreaming && isLastMessage;

    const text = message.parts
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('');

    return (
        <div className={cn('flex group', isUser ? 'justify-end' : 'justify-start')}>
            <div
                className={cn(
                    'max-w-[90%] rounded-lg px-3 py-2 motion-safe:animate-fade-in',
                    isUser
                        ? 'bg-primary/10 dark:bg-card-primary-dark text-text dark:text-text-dark'
                        : 'bg-surface-secondary dark:bg-surface-tertiary-dark/50 text-text dark:text-text-dark',
                    isEditing && 'w-full max-w-[90%]',
                )}
            >
                {isEditing ? (
                    <ChatMessageEdit
                        content={editingContent}
                        onChange={onEditChange}
                        onSave={onEditSave}
                        onCancel={onEditCancel}
                    />
                ) : (
                    <>
                        <ChatMessageContent
                            parts={message.parts}
                            isMessageStreaming={isMessageStreaming}
                            hasText={!!text}
                        />

                        <div className="flex items-center justify-between gap-2 mt-1">
                            <p
                                className={cn(
                                    'text-[10px]',
                                    isUser
                                        ? 'text-text-secondary dark:text-white/60'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}
                            />
                            {isUser && !isStreaming && (
                                <button
                                    type="button"
                                    onClick={() => onEditStart(message.id, text)}
                                    title={t('editMessage')}
                                    className="opacity-0 cursor-pointer group-hover:opacity-100 transition-opacity p-0.5 rounded text-text-secondary dark:text-white/60 hover:bg-black/10 dark:hover:bg-white/20 hover:text-text dark:hover:text-white"
                                >
                                    <Pencil className="w-2.5 h-2.5" />
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
