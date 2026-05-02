'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { useStickToBottom } from 'use-stick-to-bottom';
import { useTranslations } from 'next-intl';
import { ArrowDown } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import type { UIMessage } from '@ai-sdk/react';

interface ChatMessagesProps {
    messages: UIMessage[];
    isStreaming: boolean;
}

export function ChatMessages({ messages, isStreaming }: ChatMessagesProps) {
    const t = useTranslations('dashboard.aiChat');
    const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
    const [isAtTop, setIsAtTop] = useState(true);
    const setScrollRef = useCallback(
        (node: HTMLDivElement | null) => {
            scrollRef(node);
        },
        [scrollRef],
    );
    const setContentRef = useCallback(
        (node: HTMLDivElement | null) => {
            contentRef(node);
        },
        [contentRef],
    );

    const lastMessage = messages[messages.length - 1];
    const isWaitingForResponse = isStreaming && lastMessage?.role === 'user';

    // Scroll to bottom when user sends a message
    const prevCountRef = useRef(messages.length);
    useEffect(() => {
        if (messages.length > prevCountRef.current) {
            scrollToBottom();
        }
        prevCountRef.current = messages.length;
    }, [messages.length, scrollToBottom]);

    // Track scroll position to detect if at top
    useEffect(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        const checkScrollTop = () => {
            setIsAtTop(scrollElement.scrollTop <= 10);
        };

        checkScrollTop();
        scrollElement.addEventListener('scroll', checkScrollTop);
        return () => scrollElement.removeEventListener('scroll', checkScrollTop);
    }, [scrollRef]);

    return (
        <div className="flex-1 min-h-0 relative">
            {/* Top gradient - fade in/out based on scroll position */}
            <div
                className={cn(
                    'absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-white dark:from-surface-dark to-transparent pointer-events-none z-10',
                    'transition-opacity duration-200',
                    isAtTop ? 'opacity-0' : 'opacity-100',
                )}
            />

            {/* Bottom gradient - fade in/out based on scroll position */}
            <div
                className={cn(
                    'absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white dark:from-surface-dark to-transparent pointer-events-none z-10',
                    'transition-opacity duration-200',
                    isAtBottom ? 'opacity-0' : 'opacity-100',
                )}
            />

            <div ref={setScrollRef} className="h-full overflow-y-auto">
                <div ref={setContentRef} className="px-4 py-3 space-y-3">
                    {messages.map((message, index) => {
                        const duplicateCount = messages
                            .slice(0, index)
                            .filter((entry) => entry.id === message.id).length;
                        const key =
                            duplicateCount === 0 ? message.id : `${message.id}-${duplicateCount}`;

                        return (
                            <ChatMessage
                                key={key}
                                message={message}
                                isStreaming={isStreaming}
                                isLastMessage={index === messages.length - 1}
                            />
                        );
                    })}

                    {isWaitingForResponse && <StreamingIndicator label={t('thinking')} />}
                </div>
            </div>

            {!isAtBottom && (
                <button
                    onClick={() => scrollToBottom()}
                    className={cn(
                        'absolute bottom-3 left-1/2 -translate-x-1/2 z-20',
                        'flex items-center justify-center w-6 h-6 rounded-full',
                        'bg-white dark:bg-surface-dark',
                        'border border-border dark:border-white/10',
                        'text-text-muted dark:text-text-muted-dark',
                        'hover:text-text dark:hover:text-white',
                        'shadow-md transition-all cursor-pointer',
                    )}
                >
                    <ArrowDown className="w-3 h-3" />
                </button>
            )}
        </div>
    );
}

function StreamingIndicator({ label }: { label: string }) {
    return (
        <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2.5 bg-surface-secondary dark:bg-white/4">
                <div className="flex items-center gap-1.5">
                    <div className="flex space-x-1">
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
                    <span className="text-[10px] text-text-muted dark:text-text-muted-dark ml-1">
                        {label}
                    </span>
                </div>
            </div>
        </div>
    );
}
