'use client';

import type { UIMessage } from '@ai-sdk/react';
import { getToolName, isToolUIPart } from 'ai';
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
    return (
        <>
            {parts.map((part, i) => {
                if (part.type === 'step-start') {
                    return null;
                }

                if (part.type === 'text' && part.text?.trim()) {
                    if (isUser) {
                        return (
                            <p key={i} className="text-xs leading-relaxed whitespace-pre-wrap">
                                {part.text}
                            </p>
                        );
                    }
                    return <ChatMarkdown key={i} content={part.text} />;
                }

                if (isToolUIPart(part)) {
                    const name = getToolName(part);
                    if (!name) return null;
                    return (
                        <ChatToolResult
                            key={part.toolCallId}
                            toolName={name}
                            state={part.state}
                            output={part.state === 'output-available' ? part.output : undefined}
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
