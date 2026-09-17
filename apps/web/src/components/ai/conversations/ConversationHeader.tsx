'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronLeft, Diamond, Pencil, X } from 'lucide-react';
import type { ConversationContextType } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { ChatConversationContext } from '../ChatProvider';

/** Where an attached context object lives in the dashboard, when it has a page. */
export function contextHref(context: ChatConversationContext): string | null {
    switch (context.contextType) {
        case 'mission':
            return ROUTES.DASHBOARD_MISSION(context.contextId);
        case 'work':
            return ROUTES.DASHBOARD_WORK(context.contextId);
        case 'idea':
            return ROUTES.DASHBOARD_IDEA(context.contextId);
        case 'agent':
            return ROUTES.DASHBOARD_AGENT(context.contextId);
        case 'task':
        default:
            return null;
    }
}

export interface ConversationHeaderProps {
    /** Who the panel is talking to — also the participant switcher's trigger. */
    title: string;
    /** The name a person gave the open Conversation. */
    conversationName?: string | null;
    context?: ChatConversationContext | null;
    onBack?: () => void;
    onSwitch?: () => void;
    /** Present only when the open Conversation can be named (it exists). */
    onRename?: () => void;
    onClose?: () => void;
}

export const headerButtonClass = cn(
    'inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md',
    'text-text-muted dark:text-text-muted-dark',
    'hover:bg-surface-secondary dark:hover:bg-white/5 hover:text-text dark:hover:text-white',
    'transition-colors',
);

/**
 * The docked panel's header for an Agent (spec §6.1): Back one view, the
 * participant's name as the switcher trigger, the Conversation's name with
 * the name control, the attached context as a chip linking to it, and close
 * (FR-13, FR-14). Navigation never closes the panel — only this ✕ does.
 */
export function ConversationHeader({
    title,
    conversationName,
    context,
    onBack,
    onSwitch,
    onRename,
    onClose,
}: ConversationHeaderProps) {
    const t = useTranslations('dashboard.aiChat');

    return (
        <div
            data-testid="conversation-header"
            className="shrink-0 border-b border-border px-3 py-2 dark:border-white/6"
        >
            <div className="flex items-center gap-1">
                {onBack && (
                    <button
                        type="button"
                        onClick={onBack}
                        aria-label={t('panel.back')}
                        title={t('panel.back')}
                        data-testid="conversation-panel-back"
                        className={headerButtonClass}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                )}
                {onSwitch ? (
                    <button
                        type="button"
                        onClick={onSwitch}
                        aria-label={`${title} — ${t('panel.switch')}`}
                        data-testid="conversation-participant-trigger"
                        className="flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold text-text hover:bg-surface-secondary dark:text-white dark:hover:bg-white/5"
                    >
                        <span className="truncate">{title}</span>
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    </button>
                ) : (
                    <span className="min-w-0 truncate px-1.5 text-sm font-semibold text-text dark:text-white">
                        {title}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                    {onRename && (
                        <button
                            type="button"
                            onClick={onRename}
                            aria-label={t('conversations.nameThis')}
                            title={t('conversations.nameThis')}
                            data-testid="conversation-rename"
                            className={headerButtonClass}
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </button>
                    )}
                    {onClose && (
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={t('panel.close')}
                            title={t('panel.close')}
                            className={headerButtonClass}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
            </div>
            {conversationName && (
                <p
                    data-testid="conversation-name"
                    className="mt-0.5 truncate px-1.5 text-xs text-text-secondary dark:text-text-secondary-dark"
                >
                    {conversationName}
                </p>
            )}
            {context && <ContextChip context={context} />}
        </div>
    );
}

function ContextChip({ context }: { context: ChatConversationContext }) {
    const t = useTranslations('dashboard.aiChat.conversations');
    const type = t(`contextTypes.${context.contextType satisfies ConversationContextType}`);
    const label = context.label ? t('contextChip', { type, name: context.label }) : type;
    const href = contextHref(context);
    const chipClass =
        'mt-1 ml-1.5 inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary dark:border-white/10 dark:text-text-secondary-dark';

    const body = (
        <>
            <Diamond className="h-3 w-3 shrink-0 text-concept-missions" aria-hidden="true" />
            <span className="truncate">{label}</span>
        </>
    );
    return href ? (
        <Link
            href={href}
            data-testid="conversation-context-chip"
            className={cn(chipClass, 'hover:text-text')}
        >
            {body}
        </Link>
    ) : (
        <span data-testid="conversation-context-chip" className={chipClass}>
            {body}
        </span>
    );
}
