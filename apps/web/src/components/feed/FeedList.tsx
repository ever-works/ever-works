'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { FeedEntryDto } from '@ever-works/contracts';
import type { FeedEndReason } from '@/lib/hooks/use-feed-paging';
import { FeedRow } from './FeedRow';
import { FeedEndCard } from './FeedStates';
import { feedTargetHref } from './feed-href';

interface FeedListProps {
    entries: FeedEntryDto[];
    selectedId: string | null;
    now: Date;
    hasMore: boolean;
    loadingOlder: boolean;
    olderFailed: boolean;
    pagesLoaded: number;
    endReason: FeedEndReason;
    onLoadOlder: () => void;
    onOpenActivityLog: () => void;
    onFocusEntry: (id: string) => void;
    sentinelRef: (node: Element | null) => void;
}

/**
 * The entries, newest first, as an ARIA feed. Pages are at most 30 rows and
 * a visit stops at 20 pages, so no virtualiser is needed. Older pages load
 * from a sentinel near the bottom and from a real "Load older" button.
 */
export function FeedList({
    entries,
    selectedId,
    now,
    hasMore,
    loadingOlder,
    olderFailed,
    pagesLoaded,
    endReason,
    onLoadOlder,
    onOpenActivityLog,
    onFocusEntry,
    sentinelRef,
}: FeedListProps) {
    const t = useTranslations('dashboard.feed');
    const setSize = hasMore ? -1 : entries.length;

    return (
        <div>
            <div
                role="feed"
                aria-busy={loadingOlder}
                aria-label={t('listLabel')}
                data-testid="feed-list"
                className="space-y-0.5"
            >
                {entries.map((entry, index) => (
                    <FeedRow
                        key={entry.id}
                        entry={entry}
                        href={feedTargetHref(entry.target)}
                        selected={entry.id === selectedId}
                        position={index + 1}
                        setSize={setSize}
                        now={now}
                        onFocusEntry={onFocusEntry}
                    />
                ))}
            </div>

            {hasMore ? (
                <div className="flex flex-col items-center gap-2 py-4">
                    {/* Re-keyed per page so a sentinel still in view re-arms the observer. */}
                    <div
                        key={pagesLoaded}
                        ref={sentinelRef}
                        data-testid="feed-sentinel"
                        className="h-px w-full"
                    />
                    {olderFailed ? (
                        <p role="alert" className="text-xs text-danger">
                            {t('loadOlderFailed')}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        data-testid="feed-load-older"
                        onClick={onLoadOlder}
                        disabled={loadingOlder}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border dark:border-border-dark px-3 py-1.5 text-xs font-medium text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                        {loadingOlder ? (
                            <>
                                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                                {t('loadingOlder')}
                            </>
                        ) : olderFailed ? (
                            t('retryOlder')
                        ) : (
                            t('loadOlder')
                        )}
                    </button>
                </div>
            ) : null}

            {endReason ? (
                <FeedEndCard reason={endReason} onOpenActivityLog={onOpenActivityLog} />
            ) : null}
        </div>
    );
}
