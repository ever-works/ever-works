'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import type { ConversationSummaryView } from '@ever-works/contracts';
import { listNamedConversations } from '@/app/actions/dashboard/conversations';
import { cn } from '@/lib/utils/cn';
import { useChatContext } from '../ChatProvider';

/** "09:14" today, "Mon" this week, "12 Aug" before that. */
export function formatActivityTime(value: string, now: Date = new Date()): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const days = (now.getTime() - date.getTime()) / 86_400_000;
    if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * What a list row shows (FR-4): the name above the first-message preview when
 * the Conversation has a name, the preview alone when it does not — never
 * "Untitled". A Conversation nobody has written in yet has neither, and shows
 * the "New conversation" label.
 */
export function conversationRowText(
    conversation: Pick<ConversationSummaryView, 'title' | 'preview'>,
): { name: string | null; preview: string | null } {
    const name = conversation.title?.trim() || null;
    const preview = conversation.preview?.trim() || null;
    return { name, preview };
}

/**
 * One Agent's Conversations in the docked panel (spec §6.2): "New
 * conversation", then the rows by most recent activity with unread dots, and
 * the loading, empty and error states. The flat all-conversations History
 * (`ChatHistory`) stays exactly as it is for the assistant.
 */
export function ConversationListPanel() {
    const t = useTranslations('dashboard.aiChat.conversations');
    const tPanel = useTranslations('dashboard.aiChat.panel');
    const { panel, openAgentConversation } = useChatContext();
    const participant = panel.participant.kind === 'agent' ? panel.participant : null;
    const agentId = participant?.agentId ?? null;
    const [rows, setRows] = useState<ConversationSummaryView[] | null>(null);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async () => {
        if (!agentId) return;
        setFailed(false);
        try {
            const result = await listNamedConversations({ kind: 'direct', agentId, limit: 50 });
            if (result.ok) setRows(result.data.conversations);
            else setFailed(true);
        } catch {
            setFailed(true);
        }
    }, [agentId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one fetch per Agent the list opens for.
        setRows(null);
        void load();
    }, [load]);

    if (!participant) return null;

    const startNew = () =>
        openAgentConversation({
            agentId: participant.agentId,
            agentName: participant.name,
            agentStatus: participant.status,
        });

    return (
        <div data-testid="conversation-list-panel" className="flex min-h-0 flex-1 flex-col">
            <button
                type="button"
                onClick={startNew}
                data-testid="conversation-new"
                className="flex shrink-0 cursor-pointer items-center gap-1.5 border-b border-border px-4 py-2.5 text-left text-xs font-medium text-text hover:bg-surface-secondary dark:border-white/6 dark:text-white dark:hover:bg-white/5"
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('newConversation')}
            </button>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {failed ? (
                    <div role="alert" className="px-4 py-6 text-center text-xs">
                        <p className="text-text dark:text-text-dark">{t('loadError')}</p>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="mt-2 rounded-md border border-border px-2.5 py-1 font-medium hover:bg-surface-secondary dark:border-white/15 dark:hover:bg-white/5"
                        >
                            {t('tryAgain')}
                        </button>
                    </div>
                ) : rows === null ? (
                    <div className="space-y-3 px-4 py-4" aria-hidden="true">
                        {['w-3/4', 'w-1/2', 'w-2/3'].map((width) => (
                            <div
                                key={width}
                                className={cn(
                                    'h-3 animate-pulse rounded bg-surface-secondary dark:bg-white/5',
                                    width,
                                )}
                            />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <div
                        data-testid="conversation-list-empty"
                        className="px-4 py-6 text-center text-xs"
                    >
                        <p className="text-text dark:text-text-dark">
                            {t('emptyTitle', { agent: participant.name })}
                        </p>
                        <p className="mt-0.5 text-text-muted dark:text-text-muted-dark">
                            {t('emptyBody')}
                        </p>
                        <button
                            type="button"
                            onClick={startNew}
                            className="mt-3 rounded-md bg-primary px-3 py-1.5 font-medium text-white hover:bg-primary-hover"
                        >
                            {t('emptyAction', { agent: participant.name })}
                        </button>
                    </div>
                ) : (
                    <ul>
                        {rows.map((conversation) => {
                            const { name, preview } = conversationRowText(conversation);
                            const active = panel.conversation.id === conversation.id;
                            return (
                                <li key={conversation.id}>
                                    <button
                                        type="button"
                                        data-testid="conversation-list-row"
                                        onClick={() =>
                                            openAgentConversation({
                                                agentId: participant.agentId,
                                                agentName: participant.name,
                                                agentStatus: participant.status,
                                                conversationId: conversation.id,
                                                title: conversation.title,
                                                context:
                                                    conversation.contextType &&
                                                    conversation.contextId
                                                        ? {
                                                              contextType: conversation.contextType,
                                                              contextId: conversation.contextId,
                                                          }
                                                        : null,
                                            })
                                        }
                                        className={cn(
                                            'flex w-full cursor-pointer gap-2 border-b border-border px-4 py-2.5 text-left dark:border-white/6',
                                            'hover:bg-surface-secondary dark:hover:bg-white/5',
                                            active && 'bg-surface-secondary dark:bg-white/5',
                                        )}
                                    >
                                        <span className="min-w-0 flex-1">
                                            {name && (
                                                <span className="block truncate text-sm font-semibold text-text dark:text-white">
                                                    {name}
                                                </span>
                                            )}
                                            <span
                                                className={cn(
                                                    'block truncate text-xs',
                                                    name
                                                        ? 'text-text-muted dark:text-text-muted-dark'
                                                        : 'text-text dark:text-text-dark',
                                                )}
                                            >
                                                {preview ?? (name ? '' : t('newConversation'))}
                                            </span>
                                        </span>
                                        <span className="flex shrink-0 flex-col items-end gap-1">
                                            <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                                                {formatActivityTime(
                                                    conversation.lastMessageAt ??
                                                        conversation.updatedAt,
                                                )}
                                            </span>
                                            {conversation.unreadCount > 0 && (
                                                <span
                                                    role="img"
                                                    aria-label={tPanel('unread')}
                                                    className="h-1.5 w-1.5 rounded-full bg-primary"
                                                />
                                            )}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
