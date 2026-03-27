'use client';

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

    const lastMessage = messages[messages.length - 1];
    const isWaitingForResponse = isStreaming && lastMessage?.role === 'user';

    return (
        <div className="flex-1 min-h-0 relative">
            <div ref={scrollRef} className="h-full overflow-y-auto">
                <div ref={contentRef} className="px-4 py-3 space-y-3">
                    {messages.map((message, index) => (
                        <ChatMessage
                            key={message.id}
                            message={message}
                            isStreaming={isStreaming}
                            isLastMessage={index === messages.length - 1}
                        />
                    ))}

                    {isWaitingForResponse && <StreamingIndicator label={t('thinking')} />}
                </div>
            </div>

            {!isAtBottom && (
                <button
                    onClick={() => scrollToBottom()}
                    className={cn(
                        'absolute bottom-3 left-1/2 -translate-x-1/2 z-10',
                        'flex items-center justify-center w-8 h-8 rounded-full',
                        'bg-white dark:bg-surface-dark',
                        'border border-border dark:border-white/10',
                        'text-text-muted dark:text-text-muted-dark',
                        'hover:text-text dark:hover:text-white',
                        'shadow-md transition-all cursor-pointer',
                    )}
                >
                    <ArrowDown className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}

function StreamingIndicator({ label }: { label: string }) {
    return (
        <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2.5 bg-surface-secondary dark:bg-surface-tertiary-dark/50">
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
