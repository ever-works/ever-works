'use client';

import type { UIMessage } from '@ai-sdk/react';
import { getToolName, isToolUIPart } from 'ai';
import { usePathname } from 'next/navigation';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatToolResult } from './ChatToolResult';
import { KbCitationFooter } from '@/components/works/detail/kb/KbCitationFooter';
import { extractWorkIdFromPath } from '@/lib/kb/extract-work-id-from-path';

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
    // EW-641 row 35e — derive the Work scope from the current path
    // so the citation footer can resolve `kb:{class}/{slug}` tokens.
    // The ChatProvider is mounted in the dashboard root layout and
    // doesn't carry a workId itself; the pathname is the cheapest
    // signal that the user is currently viewing a Work. When the
    // path isn't a Work page, `workId` is null and the footer
    // renders nothing (drop-in safe across non-Work surfaces).
    const pathname = usePathname();
    const workId = extractWorkIdFromPath(pathname);

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
                    return (
                        <div key={i}>
                            <ChatMarkdown content={part.text} />
                            {workId ? <KbCitationFooter text={part.text} workId={workId} /> : null}
                        </div>
                    );
                }

                if (isToolUIPart(part)) {
                    const name = getToolName(part);
                    if (!name) return null;
                    const errorText =
                        part.state === 'output-error' &&
                        'errorText' in part &&
                        typeof part.errorText === 'string'
                            ? part.errorText
                            : undefined;
                    return (
                        <ChatToolResult
                            key={part.toolCallId}
                            toolCallId={part.toolCallId}
                            toolName={name}
                            state={part.state}
                            output={part.state === 'output-available' ? part.output : undefined}
                            errorText={errorText}
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
