'use client';

import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Tooltip } from '@/components/ui/tooltip';
import { HeaderCountBadge } from './HeaderCountBadge';

/** Spec FR-24 — above this the badge reads `9+`. */
export const WHATS_NEW_BADGE_MAX = 9;

interface WhatsNewButtonProps {
    /** Unread product changelog entries; `null` when the count is unknown. */
    unreadCount: number | null;
    onOpen: () => void;
    isOpen: boolean;
}

/**
 * What's new (AW-14) — the top-bar control that opens the product changelog
 * panel.
 *
 * Styled and badged exactly like the notification bell beside it (the shared
 * `HeaderCountBadge`), but it never polls: the count arrives once with the
 * dashboard shell and is updated from read-mark responses (spec FR-31). An
 * unknown or zero count shows no badge at all — never a `0`, never a spinner
 * (spec FR-24, S-11).
 */
export function WhatsNewButton({ unreadCount, onOpen, isOpen }: WhatsNewButtonProps) {
    const t = useTranslations('dashboard.whatsNew');

    const hasUnread = typeof unreadCount === 'number' && unreadCount > 0;
    const shownCount = hasUnread
        ? unreadCount > WHATS_NEW_BADGE_MAX
            ? `${WHATS_NEW_BADGE_MAX}+`
            : String(unreadCount)
        : '';
    const label = hasUnread ? t('controlLabelUnread', { count: shownCount }) : t('controlLabel');

    return (
        <Tooltip content={label} position="bottom">
            <button
                type="button"
                onClick={onOpen}
                aria-label={label}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                data-testid="whats-new-button"
                className={cn(
                    'p-1 rounded-md relative cursor-pointer',
                    'text-text-secondary dark:text-text-secondary-dark',
                    'hover:text-text dark:hover:text-text-dark',
                    'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                )}
            >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <HeaderCountBadge
                    count={unreadCount}
                    max={WHATS_NEW_BADGE_MAX}
                    testId="whats-new-badge"
                />
            </button>
        </Tooltip>
    );
}
