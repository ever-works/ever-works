'use client';

import { useTranslations } from 'next-intl';
import type { UIMessage } from '@ai-sdk/react';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatToolResult } from './ChatToolResult';

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
                    const toolPart = part as { toolName?: string; state: string; output?: unknown };
                    return (
                        <ChatToolResult
                            key={i}
                            toolName={toolPart.toolName ?? 'unknown'}
                            state={toolPart.state}
                            result={toolPart.output}
                        />
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
