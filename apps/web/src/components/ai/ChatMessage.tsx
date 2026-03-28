'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils/cn';
import type { UIMessage } from '@ai-sdk/react';
import { isToolUIPart } from 'ai';
import { ChatMessageContent } from './ChatMessageContent';

interface ChatMessageProps {
    message: UIMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
}

function ChatMessageInner({ message, isStreaming, isLastMessage }: ChatMessageProps) {
    const isUser = message.role === 'user';
    const isMessageStreaming = message.role === 'assistant' && isStreaming && isLastMessage;

    const hasVisibleContent = message.parts.some(
        (part) => (part.type === 'text' && part.text?.trim()) || isToolUIPart(part),
    );

    if (!isUser && !hasVisibleContent && !isMessageStreaming) {
        return null;
    }

    const hasText = message.parts.some(
        (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text' && !!p.text?.trim(),
    );

    return (
        <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div
                className={cn(
                    'max-w-[90%] rounded-lg px-3 py-2 wrap-break-word overflow-hidden',
                    isUser
                        ? 'bg-primary/10 dark:bg-card-primary-dark text-text dark:text-text-dark'
                        : 'bg-surface-secondary dark:bg-surface-tertiary-dark/50 text-text dark:text-text-dark',
                )}
            >
                <ChatMessageContent
                    parts={message.parts}
                    isUser={isUser}
                    isMessageStreaming={isMessageStreaming}
                    hasText={hasText}
                />
            </div>
        </div>
    );
}

export const ChatMessage = memo(ChatMessageInner, (prev, next) => {
    // Only re-render if the message itself changed or streaming state relevant to this message changed
    if (prev.message !== next.message) return false;
    if (prev.isLastMessage !== next.isLastMessage) return false;
    // Only care about isStreaming if this is the last message
    if (next.isLastMessage && prev.isStreaming !== next.isStreaming) return false;
    return true;
});
