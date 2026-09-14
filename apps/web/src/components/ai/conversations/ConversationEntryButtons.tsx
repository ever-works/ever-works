'use client';

import type { MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare } from 'lucide-react';
import type { ConversationContextType } from '@ever-works/contracts';
import { useChatPanel } from '@/lib/hooks/use-chat-panel';
import { cn } from '@/lib/utils/cn';
import { useChatContextOptional } from '../ChatProvider';

/**
 * Entry points elsewhere in the dashboard that open a Conversation in the
 * docked panel, in place — never by navigating away (FR-21).
 *
 * Both render nothing outside the dashboard shell (no chat provider or panel
 * controls), so a card previewed on its own stays exactly as it was.
 */

/** "Message <agent>" — opens a fresh Conversation addressed at that Agent. */
export function MessageAgentButton({
    agent,
    className,
}: {
    agent: { id: string; name: string; status?: string | null };
    className?: string;
}) {
    const t = useTranslations('dashboard.agentsPage');
    const chat = useChatContextOptional();
    const panel = useChatPanel();
    if (!chat || !panel) return null;

    return (
        <button
            type="button"
            data-testid="message-agent-button"
            onClick={() => {
                chat.openAgentConversation({
                    agentId: agent.id,
                    agentName: agent.name,
                    agentStatus: agent.status ?? null,
                });
                panel.setOpen(true);
            }}
            className={cn(entryButtonClass, className)}
        >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {t('messageAgent', { agent: agent.name })}
        </button>
    );
}

/**
 * "Chat about it" — opens the participant switcher with the object attached,
 * so the Conversation the person starts with an Agent is about it (FR-9,
 * FR-10). Its header then shows the object as a chip.
 */
export function ChatAboutButton({
    contextType,
    contextId,
    label,
    className,
}: {
    contextType: ConversationContextType;
    contextId: string;
    label: string;
    className?: string;
}) {
    const t = useTranslations('dashboard.missionsPage.menu');
    const chat = useChatContextOptional();
    const panel = useChatPanel();
    if (!chat || !panel) return null;

    return (
        <button
            type="button"
            data-testid="chat-about-button"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // Cards are links; this action must not follow them.
                event.preventDefault();
                event.stopPropagation();
                chat.openSwitcher({ contextType, contextId, label });
                panel.setOpen(true);
            }}
            className={cn(entryButtonClass, className)}
        >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {t('chat')}
        </button>
    );
}

const entryButtonClass = cn(
    'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium',
    'border-border dark:border-white/15 bg-white dark:bg-surface-dark',
    'text-text-secondary dark:text-text-secondary-dark',
    'hover:bg-surface-secondary dark:hover:bg-white/5 hover:text-text dark:hover:text-white',
    'transition-colors',
);
