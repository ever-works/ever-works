'use client';

import { cn } from '@/lib/utils/cn';
import type { UIMessage } from '@ai-sdk/react';
import { ChatMessageContent } from './ChatMessageContent';

interface ChatMessageProps {
    message: UIMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
}

export function ChatMessage({ message, isStreaming, isLastMessage }: ChatMessageProps) {
    const isUser = message.role === 'user';
    const isMessageStreaming = message.role === 'assistant' && isStreaming && isLastMessage;

    const text = message.parts
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('');

    return (
        <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div
                className={cn(
                    'max-w-[90%] rounded-lg px-3 py-2',
                    isUser
                        ? 'bg-primary/10 dark:bg-card-primary-dark text-text dark:text-text-dark'
                        : 'bg-surface-secondary dark:bg-surface-tertiary-dark/50 text-text dark:text-text-dark',
                )}
            >
                <ChatMessageContent
                    parts={message.parts}
                    isUser={isUser}
                    isMessageStreaming={isMessageStreaming}
                    hasText={!!text}
                />
            </div>
        </div>
    );
}
