'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Pin } from 'lucide-react';
import { isSafeInAppPath, type ChangelogEntryDto } from '@ever-works/contracts/api';
import { cn } from '@/lib/utils/cn';

interface ChangelogEntryCardProps {
    entry: ChangelogEntryDto;
    /** Read for this person — from the server, or marked locally since the list loaded. */
    isRead: boolean;
    /** Follow the entry's call-to-action. Only invoked for a safe in-product path. */
    onFollowCta?: (entry: ChangelogEntryDto) => void;
    /** Arrow / Home / End navigation between cards, owned by the list. */
    onCardKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
    /**
     * Registers this card with the read tracker while it is UNREAD, and
     * unregisters it when it becomes read or unmounts. Must be stable.
     */
    trackEntry?: (slug: string, element: Element | null) => void;
}

const KIND_STYLES: Record<ChangelogEntryDto['kind'], string> = {
    new: 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-light',
    improved:
        'bg-surface-secondary text-text-secondary dark:bg-surface-secondary-dark dark:text-text-secondary-dark',
    fixed: 'bg-surface-secondary text-text-secondary dark:bg-surface-secondary-dark dark:text-text-secondary-dark',
    security: 'bg-danger/10 text-danger dark:bg-danger/20',
};

function formatPublishedAt(value: string, locale: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    try {
        return new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(date);
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

/**
 * What's new (AW-14) — one product changelog entry.
 *
 * Title and body are content, not chrome: rendered as plain text (React
 * escapes them, so `<b>x</b>` shows literally) with line breaks preserved,
 * and never passed through the translation layer (spec FR-5, FR-11).
 *
 * Read state changes only the unread dot and the title weight. The dot keeps
 * its space when hidden, so a card occupies exactly the same box read or
 * unread and never moves when it is marked (spec FR-20). Unread is also
 * announced as text, not conveyed by colour alone (spec FR-53).
 *
 * The call-to-action renders only when the target is an in-product path;
 * anything else renders no button while the rest of the card stays intact
 * (spec FR-39, FR-40). The card never inspects the reader's plan or
 * connections to decide whether to show it (spec FR-43).
 */
export function ChangelogEntryCard({
    entry,
    isRead,
    onFollowCta,
    onCardKeyDown,
    trackEntry,
}: ChangelogEntryCardProps) {
    const t = useTranslations('dashboard.whatsNew');
    const locale = useLocale();
    const ref = useRef<HTMLElement>(null);
    const { slug } = entry;

    // Only an unread card is watched. Keyed on the read state and the slug
    // alone, so a re-render never restarts the card's dwell clock.
    useEffect(() => {
        if (isRead || !trackEntry) {
            return undefined;
        }
        trackEntry(slug, ref.current);
        return () => trackEntry(slug, null);
    }, [isRead, slug, trackEntry]);

    const cta = entry.cta && isSafeInAppPath(entry.cta.href) ? entry.cta : null;
    const titleId = `whats-new-entry-${entry.slug}`;

    const followCta = () => {
        if (cta) {
            onFollowCta?.(entry);
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        // Enter on the focused card itself follows its call-to-action
        // (spec FR-52); Enter on the button inside is the button's own.
        if (event.key === 'Enter' && event.target === event.currentTarget && cta) {
            event.preventDefault();
            followCta();
            return;
        }
        onCardKeyDown?.(event);
    };

    return (
        <article
            ref={ref}
            tabIndex={0}
            aria-labelledby={titleId}
            data-testid="whats-new-entry"
            data-slug={entry.slug}
            data-read={isRead ? 'true' : 'false'}
            onKeyDown={handleKeyDown}
            className={cn(
                'rounded-lg border p-4 outline-none transition-colors',
                'border-border dark:border-border-dark',
                'bg-white dark:bg-surface-dark',
                'focus-visible:ring-2 focus-visible:ring-primary/60',
            )}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span
                    aria-hidden="true"
                    data-testid="whats-new-unread-dot"
                    className={cn(
                        'h-2 w-2 shrink-0 rounded-full bg-primary',
                        isRead && 'invisible',
                    )}
                />
                {!isRead && <span className="sr-only">{t('unread')}</span>}
                {entry.pinned && (
                    <span className="inline-flex items-center gap-1 font-medium text-text-secondary dark:text-text-secondary-dark">
                        <Pin className="h-3 w-3" aria-hidden="true" />
                        {t('pinned')}
                    </span>
                )}
                <span
                    className={cn('rounded-full px-2 py-0.5 font-medium', KIND_STYLES[entry.kind])}
                >
                    {t(`kinds.${entry.kind}`)}
                </span>
                <span className="text-text-secondary dark:text-text-secondary-dark">
                    {t(`filters.${entry.category}`)}
                </span>
                <time
                    dateTime={entry.publishedAt}
                    className="ml-auto text-text-muted dark:text-text-muted-dark"
                >
                    {formatPublishedAt(entry.publishedAt, locale)}
                </time>
            </div>

            <h3
                id={titleId}
                className={cn(
                    'mt-2 text-sm text-text dark:text-text-dark',
                    isRead ? 'font-normal' : 'font-semibold',
                )}
            >
                {entry.title}
            </h3>
            <p className="mt-1 whitespace-pre-line text-sm text-text-secondary dark:text-text-secondary-dark">
                {entry.body}
            </p>

            {cta && (
                <button
                    type="button"
                    onClick={followCta}
                    data-testid="whats-new-entry-cta"
                    className={cn(
                        'mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium',
                        'border-border text-text hover:bg-surface',
                        'dark:border-border-dark dark:text-text-dark dark:hover:bg-surface-secondary-dark',
                    )}
                >
                    {cta.label}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            )}
        </article>
    );
}
