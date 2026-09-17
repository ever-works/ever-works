'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { UIMessage } from '@ai-sdk/react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { MAX_CONVERSATION_BODY_BYTES } from '@ever-works/contracts';
import {
    createNamedConversation,
    markConversationRead,
    type ConversationActionResult,
} from '@/app/actions/dashboard/conversations';
import { useChatPanelVisible } from '@/lib/hooks/use-chat-panel';
import { useConversationOutbox, type OutboxRow } from '@/lib/hooks/use-conversation-outbox';
import { useConversationStream } from '@/lib/hooks/use-conversation-stream';
import { cn } from '@/lib/utils/cn';
import { ChatInput } from '../ChatInput';
import { ChatMessage } from '../ChatMessage';
import { useChatContext } from '../ChatProvider';
import {
    ConversationAttachmentList,
    composerAttachmentsToConversation,
    outboxRowAttachments,
} from './ConversationAttachmentList';
import { MessageRetryBar } from './MessageRetryBar';

/** The bubble a row renders through the assistant's own message component. */
export function outboxRowToUiMessage(row: OutboxRow): UIMessage {
    if (row.source === 'local') {
        return {
            id: row.entry.clientMessageId,
            role: 'user',
            parts: [{ type: 'text', text: row.entry.body }],
        };
    }
    return {
        id: row.message.id,
        role: row.message.authorType === 'user' ? 'user' : 'assistant',
        parts: [{ type: 'text', text: row.message.content }],
    };
}

/**
 * The Conversation view for one Agent — the body `ChatInterface` renders
 * when the panel is talking to an Agent instead of the assistant.
 *
 * Messages arrive three ways and meet in one outbox: the page load, the live
 * stream (with its 30 s fallback), and the answer to the person's own send.
 * The composer is the assistant's `ChatInput`, with mentions, the 16 KB guard
 * and the Agent's name in the placeholder switched on.
 */
export function AgentConversation() {
    const t = useTranslations('dashboard.aiChat');
    const { panel, updateNamedConversation, panelBack } = useChatContext();
    const participant = panel.participant.kind === 'agent' ? panel.participant : null;
    const conversationId = panel.conversation.id;
    const context = panel.conversation.context;
    const agentId = participant?.agentId ?? '';
    const agentName = participant?.name ?? '';

    // One creation per fresh Conversation, however many sends race to it.
    const creating = useRef<Promise<ConversationActionResult<string>> | null>(null);
    useEffect(() => {
        creating.current = null;
    }, [agentId, conversationId]);

    const ensureConversation = useCallback(async (): Promise<ConversationActionResult<string>> => {
        if (conversationId) return { ok: true, data: conversationId };
        if (!creating.current) {
            creating.current = createNamedConversation({
                agentId,
                ...(context
                    ? { contextType: context.contextType, contextId: context.contextId }
                    : {}),
            })
                .then((result): ConversationActionResult<string> => {
                    if (!result.ok) {
                        creating.current = null;
                        return result;
                    }
                    updateNamedConversation({ id: result.data.id });
                    return { ok: true, data: result.data.id };
                })
                .catch((error: unknown) => {
                    // Unreachable (offline): let the next Retry try again.
                    creating.current = null;
                    throw error;
                });
        }
        return creating.current;
    }, [agentId, context, conversationId, updateNamedConversation]);

    const outbox = useConversationOutbox({
        conversationId,
        draftKey: `draft:${agentId}`,
        ensureConversation,
        // The Conversation is gone or out of this workspace: back to the list (FR-20).
        onGone: panelBack,
    });

    // The docked panel keeps this view mounted while closed or collapsed; the
    // stream and its poll stand down until it is back on screen.
    const panelVisible = useChatPanelVisible();
    useConversationStream(
        conversationId,
        {
            onMessage: outbox.receive,
            onResync: () => void outbox.reload(),
        },
        { paused: !panelVisible },
    );

    const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
    const rows = outbox.rows;
    const rowCount = rows.length;
    useEffect(() => {
        if (rowCount > 0) void scrollToBottom();
    }, [rowCount, scrollToBottom]);

    // Clear the unread marker once the newest message has been seen (FR-24).
    const newestServerId = useMemo(() => {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (row.source === 'server') return row.message.id;
        }
        return null;
    }, [rows]);
    const lastMarked = useRef<string | null>(null);
    useEffect(() => {
        if (!conversationId || !newestServerId || !isAtBottom) return;
        if (lastMarked.current === newestServerId) return;
        lastMarked.current = newestServerId;
        void markConversationRead(conversationId, newestServerId).catch(() => undefined);
    }, [conversationId, newestServerId, isAtBottom]);

    if (!participant) return null;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div ref={contentRef} className="space-y-3 px-4 py-3">
                    {outbox.loadState === 'loading' && rows.length === 0 ? (
                        <div className="space-y-2" aria-hidden="true">
                            <div className="ml-auto h-8 w-2/3 animate-pulse rounded-lg bg-surface-secondary dark:bg-white/5" />
                            <div className="h-12 w-3/4 animate-pulse rounded-lg bg-surface-secondary dark:bg-white/5" />
                        </div>
                    ) : outbox.loadState === 'error' && rows.length === 0 ? (
                        <div role="alert" className="py-6 text-center text-xs">
                            <p className="text-text dark:text-text-dark">
                                {t('conversations.messagesLoadError')}
                            </p>
                            <button
                                type="button"
                                onClick={() => void outbox.reload()}
                                className="mt-2 rounded-md border border-border px-2.5 py-1 font-medium hover:bg-surface-secondary dark:border-white/15 dark:hover:bg-white/5"
                            >
                                {t('conversations.tryAgain')}
                            </button>
                        </div>
                    ) : rows.length === 0 ? (
                        <p
                            data-testid="conversation-start-hint"
                            className="py-8 text-center text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('conversations.startHint', { agent: agentName })}
                        </p>
                    ) : (
                        rows.map((row) => {
                            const key =
                                row.source === 'local' ? row.entry.clientMessageId : row.message.id;
                            const fromPerson =
                                row.source === 'local' || row.message.authorType === 'user';
                            const failed =
                                row.source === 'local'
                                    ? row.entry.status === 'failed'
                                    : row.message.status === 'failed';
                            const sending =
                                (row.source === 'local' && row.entry.status === 'sending') ||
                                (row.source === 'server' && row.retrying);
                            const failureCode =
                                row.source === 'local'
                                    ? row.entry.failureCode
                                    : row.message.failureCode;
                            return (
                                <div
                                    key={key}
                                    data-testid="conversation-message"
                                    data-status={sending ? 'sending' : failed ? 'failed' : 'sent'}
                                    className={cn(
                                        'flex flex-col',
                                        fromPerson ? 'items-end' : 'items-start',
                                    )}
                                >
                                    {!(
                                        row.source === 'server' &&
                                        row.message.authorType === 'system'
                                    ) && (
                                        <span className="mb-0.5 px-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                                            {fromPerson ? t('conversations.you') : agentName}
                                        </span>
                                    )}
                                    <div className="w-full">
                                        <ChatMessage
                                            message={outboxRowToUiMessage(row)}
                                            isStreaming={false}
                                            isLastMessage={false}
                                        />
                                    </div>
                                    <ConversationAttachmentList
                                        attachments={outboxRowAttachments(row)}
                                        align={fromPerson ? 'end' : 'start'}
                                    />
                                    {(failed || sending) && (
                                        <MessageRetryBar
                                            failureCode={failureCode}
                                            agentName={agentName}
                                            agentId={agentId}
                                            size={
                                                row.source === 'local'
                                                    ? row.entry.details?.size
                                                    : undefined
                                            }
                                            max={
                                                row.source === 'local'
                                                    ? row.entry.details?.max
                                                    : undefined
                                            }
                                            sending={sending}
                                            onRetry={() => void outbox.retry(row)}
                                            onDiscard={() => void outbox.discard(row)}
                                        />
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            <ChatInput
                // Replies arrive as messages, not a token stream, so there is
                // never a generation to stop here.
                isStreaming={false}
                onStop={() => undefined}
                onSubmit={(text, attachments) => {
                    const uploads = composerAttachmentsToConversation(attachments);
                    // A message may be only files ("here, look at this"); its
                    // body then names them, since a body cannot be empty.
                    const body =
                        text || attachments.map((attachment) => attachment.name).join(', ');
                    void outbox.send(body, uploads);
                }}
                placeholder={t('conversations.placeholder', { agent: agentName })}
                mentions
                maxBodyBytes={MAX_CONVERSATION_BODY_BYTES}
                showModelSelector={false}
            />
        </div>
    );
}
