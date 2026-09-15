'use client';

import type { KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import type { ChangelogCategory, ChangelogEntryDto } from '@ever-works/contracts/api';
import { EmptyState } from '@/components/common/EmptyState';
import { ChangelogEntryCard } from './ChangelogEntryCard';

export type ChangelogListStatus = 'loading' | 'error' | 'ready';

interface ChangelogListProps {
    status: ChangelogListStatus;
    entries: ChangelogEntryDto[];
    /** Slugs marked read locally since the list loaded (the server's `isRead` still counts). */
    readSlugs: ReadonlySet<string>;
    /** The active category filter; `null` for All. Drives which empty state renders. */
    activeCategory: ChangelogCategory | null;
    onRetry: () => void;
    /** Clears the category filter — the filtered empty state's action. */
    onClearFilter?: () => void;
    onFollowCta?: (entry: ChangelogEntryDto) => void;
    /** Registers an UNREAD card with the read tracker (or unregisters it with `null`). */
    trackEntry?: (slug: string, element: Element | null) => void;
}

function SkeletonCard() {
    return (
        <div
            data-testid="whats-new-skeleton"
            aria-hidden="true"
            className="rounded-lg border border-border p-4 dark:border-border-dark"
        >
            <div className="flex items-center gap-2">
                <div className="h-4 w-14 animate-pulse rounded-full bg-surface-secondary dark:bg-surface-secondary-dark" />
                <div className="h-3 w-28 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
            </div>
            <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
            <div className="mt-2 h-3 w-full animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
            <div className="mt-1.5 h-3 w-2/3 animate-pulse rounded bg-surface-secondary dark:bg-surface-secondary-dark" />
        </div>
    );
}

/**
 * What's new (AW-14) — the list body shared by every changelog surface.
 *
 * Four states, each reachable from props alone: three skeleton cards while
 * loading (no spinner, no text), the error state with a retry, the empty
 * states — "nothing has ever shipped" and "this filter matched nothing" are
 * different messages (spec S-12, S-13) — and the list.
 *
 * Empty states reuse the shared `EmptyState` primitive.
 */
export function ChangelogList({
    status,
    entries,
    readSlugs,
    activeCategory,
    onRetry,
    onClearFilter,
    onFollowCta,
    trackEntry,
}: ChangelogListProps) {
    const t = useTranslations('dashboard.whatsNew');

    if (status === 'loading') {
        return (
            <div className="space-y-3">
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div role="alert" data-testid="whats-new-error">
                <EmptyState
                    icon={<span aria-hidden="true" />}
                    title={t('error.title')}
                    action={{ label: t('error.retry'), onClick: onRetry }}
                />
            </div>
        );
    }

    if (entries.length === 0) {
        if (activeCategory) {
            return (
                <div data-testid="whats-new-empty-filtered">
                    <EmptyState
                        title={t('emptyFiltered.title')}
                        description={t('emptyFiltered.description', {
                            category: t(`filters.${activeCategory}`),
                        })}
                        action={
                            onClearFilter
                                ? { label: t('emptyFiltered.action'), onClick: onClearFilter }
                                : undefined
                        }
                    />
                </div>
            );
        }
        return (
            <div data-testid="whats-new-empty">
                <EmptyState
                    icon={
                        <Sparkles
                            className="mb-4 h-10 w-10 text-text-muted dark:text-text-muted-dark"
                            aria-hidden="true"
                        />
                    }
                    title={t('empty.title')}
                    description={t('empty.description')}
                />
            </div>
        );
    }

    // Spec FR-52 — ↑/↓ move between cards, Home/End jump to the ends.
    const moveFocus = (event: KeyboardEvent<HTMLElement>, index: number) => {
        if (event.target !== event.currentTarget) {
            return;
        }
        const list = event.currentTarget.closest('[data-testid="whats-new-list"]');
        const last = entries.length - 1;
        let next: number | null = null;
        if (event.key === 'ArrowDown') next = Math.min(index + 1, last);
        else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = last;
        if (next === null) {
            return;
        }
        event.preventDefault();
        list?.querySelectorAll<HTMLElement>('[data-testid="whats-new-entry"]')[next]?.focus();
    };

    return (
        <div className="space-y-3" data-testid="whats-new-list">
            {entries.map((entry, index) => {
                const isRead = entry.isRead || readSlugs.has(entry.slug);
                return (
                    <ChangelogEntryCard
                        key={entry.slug}
                        entry={entry}
                        isRead={isRead}
                        onFollowCta={onFollowCta}
                        onCardKeyDown={(event) => moveFocus(event, index)}
                        trackEntry={trackEntry}
                    />
                );
            })}
        </div>
    );
}
