'use client';

import { useTranslations } from 'next-intl';
import type { UIMessage } from '@ai-sdk/react';
import { ChatMarkdown } from './ChatMarkdown';

type MessagePart = UIMessage['parts'][number];

interface ChatMessageContentProps {
    parts: MessagePart[];
    isUser: boolean;
    isMessageStreaming: boolean;
    hasText: boolean;
}

export function ChatMessageContent({
    parts,
    isUser,
    isMessageStreaming,
    hasText,
}: ChatMessageContentProps) {
    const t = useTranslations('dashboard.aiChat');

    return (
        <>
            {parts.map((part, i) => {
                if (part.type === 'text' && part.text) {
                    if (isUser) {
                        return (
                            <p key={i} className="text-xs leading-relaxed whitespace-pre-wrap">
                                {part.text}
                            </p>
                        );
                    }
                    return <ChatMarkdown key={i} content={part.text} />;
                }

                if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
                    const toolPart = part as { toolName?: string; state: string };
                    return (
                        <div
                            key={i}
                            className="mt-1 px-2 py-1.5 rounded bg-black/5 dark:bg-white/5 text-[11px] text-text-muted dark:text-text-muted-dark"
                        >
                            <span className="font-medium">{toolPart.toolName ?? 'tool'}</span>
                            {toolPart.state === 'result' && (
                                <span className="ml-1 text-text-secondary dark:text-white/60">
                                    {t('toolCompleted')}
                                </span>
                            )}
                        </div>
                    );
                }

                return null;
            })}

            {isMessageStreaming && !hasText && (
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
        </>
    );
}
