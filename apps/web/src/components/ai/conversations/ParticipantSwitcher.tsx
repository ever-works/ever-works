'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, ChevronRight, Sparkles } from 'lucide-react';
import type { ConversationSummaryView } from '@ever-works/contracts';
import type { AgentPickerOption } from '@/lib/api/agents';
import { listAgentOptionsAction } from '@/app/actions/agents';
import { listNamedConversations } from '@/app/actions/dashboard/conversations';
import { cn } from '@/lib/utils/cn';
import { useChatContext } from '../ChatProvider';
import { formatActivityTime } from './ConversationListPanel';

/** Agent statuses that can answer a message right now. */
const ADDRESSABLE = new Set(['active', 'running']);

export interface SwitcherAgentRow extends AgentPickerOption {
    lastMessageAt: string | null;
    unread: number;
}

/**
 * Order the switcher's Agents: the ones this person talked to most recently
 * first, then everyone else by name; `query` filters by name or slug.
 */
export function orderSwitcherAgents(
    agents: readonly AgentPickerOption[],
    conversations: readonly ConversationSummaryView[],
    query: string,
): SwitcherAgentRow[] {
    const activity = new Map<string, { lastMessageAt: string | null; unread: number }>();
    for (const conversation of conversations) {
        if (!conversation.agentId) continue;
        const seen = activity.get(conversation.agentId);
        const at = conversation.lastMessageAt ?? conversation.updatedAt;
        activity.set(conversation.agentId, {
            lastMessageAt: seen?.lastMessageAt && seen.lastMessageAt > at ? seen.lastMessageAt : at,
            unread: (seen?.unread ?? 0) + (conversation.unreadCount ?? 0),
        });
    }
    const needle = query.trim().toLowerCase();
    return agents
        .filter(
            (agent) =>
                !needle ||
                agent.name.toLowerCase().includes(needle) ||
                agent.slug.toLowerCase().includes(needle),
        )
        .map((agent) => ({
            ...agent,
            lastMessageAt: activity.get(agent.id)?.lastMessageAt ?? null,
            unread: activity.get(agent.id)?.unread ?? 0,
        }))
        .sort((a, b) => {
            if (a.lastMessageAt && b.lastMessageAt)
                return b.lastMessageAt.localeCompare(a.lastMessageAt);
            if (a.lastMessageAt) return -1;
            if (b.lastMessageAt) return 1;
            return a.name.localeCompare(b.name);
        });
}

/**
 * The participant switcher (FR-15, spec §6.3): the AI assistant, then the
 * person's Agents — most recently addressed first, with unread and
 * not-addressable markers. Picking an Agent opens its Conversation list; when
 * an entry point asked to talk about something ("Chat about it" on a
 * Mission), picking an Agent starts that Conversation directly instead.
 */
export function ParticipantSwitcher() {
    const t = useTranslations('dashboard.aiChat');
    const { panel, openAssistant, openAgentList, openAgentConversation } = useChatContext();
    const [agents, setAgents] = useState<AgentPickerOption[] | null>(null);
    const [conversations, setConversations] = useState<ConversationSummaryView[]>([]);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState('');

    const load = useCallback(async () => {
        setFailed(false);
        const [agentResult, conversationResult] = await Promise.allSettled([
            listAgentOptionsAction(100),
            listNamedConversations({ kind: 'direct', limit: 50 }),
        ]);
        if (agentResult.status === 'fulfilled') setAgents(agentResult.value);
        else setFailed(true);
        if (conversationResult.status === 'fulfilled' && conversationResult.value.ok) {
            setConversations(conversationResult.value.data.conversations);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one fetch when the switcher opens.
        void load();
    }, [load]);

    const rows = useMemo(
        () => orderSwitcherAgents(agents ?? [], conversations, query),
        [agents, conversations, query],
    );
    const pending = panel.pendingContext;

    return (
        <div
            data-testid="conversation-participant-switcher"
            className="flex min-h-0 flex-1 flex-col"
        >
            <div className="shrink-0 px-3 pt-2 pb-2">
                {pending && (
                    <p
                        data-testid="conversation-pending-context"
                        className="mb-2 rounded-md bg-surface-secondary px-2 py-1.5 text-xs text-text-secondary dark:bg-white/5 dark:text-text-secondary-dark"
                    >
                        {t('panel.aboutContext', {
                            name:
                                pending.label ??
                                t(`conversations.contextTypes.${pending.contextType}`),
                        })}
                    </p>
                )}
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('panel.switchPlaceholder')}
                    aria-label={t('panel.switchPlaceholder')}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs text-text focus:border-primary/60 focus:outline-none dark:border-white/10 dark:text-white"
                />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {!pending && (
                    <button
                        type="button"
                        onClick={openAssistant}
                        data-testid="conversation-switch-assistant"
                        className={rowClass}
                    >
                        <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                                {t('panel.assistant')}
                            </span>
                            <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                                {t('panel.assistantHint')}
                            </span>
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
                    </button>
                )}

                <p className="mt-3 mb-1 px-2 text-[10px] font-semibold tracking-wide text-text-muted uppercase dark:text-text-muted-dark">
                    {t('panel.agents')}
                </p>
                {agents === null && !failed ? (
                    <div className="space-y-2 px-2" aria-hidden="true">
                        {[0, 1, 2].map((key) => (
                            <div
                                key={key}
                                className="h-8 animate-pulse rounded-md bg-surface-secondary dark:bg-white/5"
                            />
                        ))}
                    </div>
                ) : failed ? (
                    <div className="px-2 text-xs text-text-muted dark:text-text-muted-dark">
                        <p>{t('panel.agentsLoadError')}</p>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="mt-1 text-primary hover:underline"
                        >
                            {t('conversations.tryAgain')}
                        </button>
                    </div>
                ) : rows.length === 0 ? (
                    <p className="px-2 text-xs text-text-muted dark:text-text-muted-dark">
                        {t('panel.noAgents')}
                    </p>
                ) : (
                    rows.map((agent) => {
                        const addressable = ADDRESSABLE.has(agent.status);
                        return (
                            <button
                                key={agent.id}
                                type="button"
                                data-testid="conversation-switch-agent"
                                onClick={() =>
                                    pending
                                        ? openAgentConversation({
                                              agentId: agent.id,
                                              agentName: agent.name,
                                              agentStatus: agent.status,
                                              context: pending,
                                          })
                                        : openAgentList({
                                              agentId: agent.id,
                                              name: agent.name,
                                              status: agent.status,
                                          })
                                }
                                className={rowClass}
                            >
                                <Bot
                                    className="h-4 w-4 shrink-0 text-concept-agents"
                                    aria-hidden="true"
                                />
                                <span
                                    aria-hidden="true"
                                    title={addressable ? undefined : t('panel.notAddressable')}
                                    className={cn(
                                        'h-1.5 w-1.5 shrink-0 rounded-full',
                                        addressable ? 'bg-success' : 'border border-text-muted',
                                    )}
                                />
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {agent.name}
                                </span>
                                {agent.unread > 0 && (
                                    <span
                                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                                        aria-label={t('panel.unread')}
                                    />
                                )}
                                {agent.lastMessageAt && (
                                    <span className="shrink-0 text-[11px] text-text-muted dark:text-text-muted-dark">
                                        {formatActivityTime(agent.lastMessageAt)}
                                    </span>
                                )}
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );
}

const rowClass = cn(
    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left',
    'text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-white/5 transition-colors',
);
