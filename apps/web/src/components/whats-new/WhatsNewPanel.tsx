'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { X } from 'lucide-react';
import type {
    ChangelogCategory,
    ChangelogEntryDto,
    ChangelogListResponseDto,
} from '@ever-works/contracts/api';
import { isSafeInAppPath } from '@ever-works/contracts/api';
import { cn } from '@/lib/utils/cn';
import { getChangelog, markAllChangelogRead, markChangelogRead } from '@/app/actions/changelog';
import { ChangelogList, type ChangelogListStatus } from './ChangelogList';
import { ChangelogFilterChips } from './ChangelogFilterChips';
import { useChangelogReadTracker } from './use-changelog-read-tracker';

/** How long the inline "All caught up" confirmation stays after mark-all-read. */
export const MARKED_ALL_CONFIRMATION_MS = 3000;

interface WhatsNewPanelProps {
    open: boolean;
    onClose: () => void;
    /** The top-bar count; `null` when unknown. Drives the subheading. */
    unreadCount: number | null;
    /** Report a fresh count (or `null` when it became unknown) back to the shell. */
    onUnreadCountChange: (count: number | null) => void;
}

/**
 * What's new (AW-14) — the product changelog slide-over.
 *
 * Built on the same Headless UI `Dialog` + `Transition` slide-over as the
 * Help drawer, so it inherits the focus trap, Escape-to-close and focus
 * restoration to the control that opened it (spec FR-51). It opens only when
 * the reader asks (spec FR-30) and never navigates (spec FR-29).
 *
 * The body mounts only while the panel is open, so the entry list is fetched
 * on open rather than with the shell (spec FR-26, FR-31), the filter resets
 * to All on every open (spec FR-35), and closing flushes any pending read
 * marks.
 */
export function WhatsNewPanel({
    open,
    onClose,
    unreadCount,
    onUnreadCountChange,
}: WhatsNewPanelProps) {
    const t = useTranslations('dashboard.whatsNew');
    const count = typeof unreadCount === 'number' && unreadCount > 0 ? unreadCount : 0;
    // An unknown count (the shell could not fetch it, or the list failed) says
    // nothing rather than claiming the reader is caught up.
    const subtitle =
        unreadCount === null
            ? null
            : count === 0
              ? t('subtitleCaughtUp')
              : count === 1
                ? t('subtitleUnreadOne')
                : t('subtitleUnread', { count });

    return (
        <Transition show={open}>
            <Dialog onClose={onClose} className="relative z-50" data-testid="whats-new-panel">
                <TransitionChild
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/50 dark:bg-black/70" />
                </TransitionChild>

                <div className="fixed inset-0 overflow-hidden">
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full sm:pl-10">
                            <TransitionChild
                                enter="transform transition ease-in-out duration-300"
                                enterFrom="translate-x-full"
                                enterTo="translate-x-0"
                                leave="transform transition ease-in-out duration-200"
                                leaveFrom="translate-x-0"
                                leaveTo="translate-x-full"
                            >
                                <DialogPanel className="pointer-events-auto w-screen sm:w-[420px]">
                                    <div
                                        className={cn(
                                            'flex h-full flex-col overflow-y-auto',
                                            'bg-white dark:bg-surface-dark',
                                            'shadow-xl',
                                        )}
                                    >
                                        <div
                                            className={cn(
                                                'sticky top-0 z-10 px-6 pt-4 pb-3',
                                                'bg-white/90 dark:bg-surface-dark/90 backdrop-blur',
                                                'border-b border-border dark:border-border-dark',
                                            )}
                                        >
                                            <div className="flex items-center justify-between">
                                                <DialogTitle
                                                    tabIndex={-1}
                                                    autoFocus
                                                    className={cn(
                                                        'text-base font-semibold outline-none',
                                                        'text-text dark:text-text-dark',
                                                    )}
                                                >
                                                    {t('title')}
                                                </DialogTitle>
                                                <button
                                                    type="button"
                                                    onClick={onClose}
                                                    aria-label={t('close')}
                                                    className={cn(
                                                        'p-2 rounded-md transition-colors',
                                                        'text-text-secondary dark:text-text-secondary-dark',
                                                        'hover:text-text dark:hover:text-text-dark',
                                                        'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                                    )}
                                                >
                                                    <X className="w-5 h-5" aria-hidden="true" />
                                                </button>
                                            </div>
                                            <p
                                                className="mt-1 min-h-4 text-xs text-text-secondary dark:text-text-secondary-dark"
                                                data-testid="whats-new-subtitle"
                                            >
                                                {subtitle}
                                            </p>
                                        </div>

                                        <WhatsNewPanelBody
                                            onClose={onClose}
                                            unreadCount={count}
                                            onUnreadCountChange={onUnreadCountChange}
                                        />
                                    </div>
                                </DialogPanel>
                            </TransitionChild>
                        </div>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}

interface WhatsNewPanelBodyProps {
    onClose: () => void;
    unreadCount: number;
    onUnreadCountChange: (count: number | null) => void;
}

/** The part of the panel that lives only while it is open. */
function WhatsNewPanelBody({ onClose, unreadCount, onUnreadCountChange }: WhatsNewPanelBodyProps) {
    const t = useTranslations('dashboard.whatsNew');
    const router = useRouter();

    const [category, setCategory] = useState<ChangelogCategory | null>(null);
    const [status, setStatus] = useState<ChangelogListStatus>('loading');
    const [page, setPage] = useState<ChangelogListResponseDto | null>(null);
    const [readSlugs, setReadSlugs] = useState<ReadonlySet<string>>(() => new Set());
    const [markingAll, setMarkingAll] = useState(false);
    const [markedAll, setMarkedAll] = useState(false);
    /** Bumped by "Try again" to re-run the load for the same filter. */
    const [attempt, setAttempt] = useState(0);

    const onUnreadCountChangeRef = useRef(onUnreadCountChange);
    useEffect(() => {
        onUnreadCountChangeRef.current = onUnreadCountChange;
    });

    // Loads the page for the current filter. State is written only when the
    // round trip settles, and a load superseded by a newer filter or retry is
    // ignored. Handlers that start a load flip the list to loading themselves.
    useEffect(() => {
        let superseded = false;
        getChangelog({ category: category ?? undefined })
            // The action never throws, but the round trip to it can (a dropped
            // connection, a server restart). Both land in the error state.
            .catch(() => ({ success: false as const, data: undefined }))
            .then((result) => {
                if (superseded) {
                    return;
                }
                if (!result.success || !result.data) {
                    setPage(null);
                    setStatus('error');
                    // Spec S-10 — hide the badge rather than show a stale number.
                    onUnreadCountChangeRef.current(null);
                    return;
                }
                setPage(result.data);
                setStatus('ready');
                onUnreadCountChangeRef.current(result.data.unreadCount);
            });
        return () => {
            superseded = true;
        };
    }, [category, attempt]);

    const changeCategory = (next: ChangelogCategory | null) => {
        if (next === category) {
            return;
        }
        setStatus('loading');
        setCategory(next);
    };

    const retry = () => {
        setStatus('loading');
        setAttempt((previous) => previous + 1);
    };

    useEffect(() => {
        if (!markedAll) {
            return undefined;
        }
        const timer = setTimeout(() => setMarkedAll(false), MARKED_ALL_CONFIRMATION_MS);
        return () => clearTimeout(timer);
    }, [markedAll]);

    const tracker = useChangelogReadTracker({
        flush: markChangelogRead,
        onRead: (slugs) =>
            setReadSlugs((previous) => {
                const next = new Set(previous);
                for (const slug of slugs) {
                    next.add(slug);
                }
                return next;
            }),
        onUnreadCount: (fresh) => onUnreadCountChangeRef.current(fresh),
    });

    const handleMarkAllRead = async () => {
        setMarkingAll(true);
        const result = await markAllChangelogRead().catch(() => ({
            success: false as const,
            unreadCount: undefined,
        }));
        setMarkingAll(false);
        if (!result.success) {
            // Spec §9.2 — a refused mark-all changes nothing and is retryable.
            setStatus('error');
            return;
        }
        setReadSlugs(
            (previous) =>
                new Set([...previous, ...(page?.entries ?? []).map((entry) => entry.slug)]),
        );
        onUnreadCountChangeRef.current(result.unreadCount ?? 0);
        setMarkedAll(true);
    };

    const handleFollowCta = (entry: ChangelogEntryDto) => {
        const href = entry.cta?.href;
        if (!isSafeInAppPath(href)) {
            return;
        }
        // Spec FR-42 — marked read immediately, flushed as the panel unmounts.
        tracker.markRead([entry.slug]);
        onClose();
        router.push(href);
    };

    const entries = page?.entries ?? [];
    const hasUnreadOnScreen = entries.some((entry) => !entry.isRead && !readSlugs.has(entry.slug));

    return (
        <div className="flex flex-1 flex-col px-6 py-4">
            <ChangelogFilterChips
                value={category}
                onChange={changeCategory}
                categoriesWithEntries={page?.categoriesWithEntries ?? null}
            />
            <div className="mt-2 flex min-h-7 items-center justify-end">
                {markedAll ? (
                    <span
                        role="status"
                        className="text-xs text-text-secondary dark:text-text-secondary-dark"
                    >
                        {t('markedAllRead')}
                    </span>
                ) : (
                    (unreadCount > 0 || hasUnreadOnScreen) && (
                        <button
                            type="button"
                            onClick={() => void handleMarkAllRead()}
                            disabled={markingAll}
                            data-testid="whats-new-mark-all"
                            className="text-xs font-medium text-primary hover:underline disabled:opacity-60 dark:text-primary-light"
                        >
                            {t('markAllRead')}
                        </button>
                    )
                )}
            </div>
            <div className="mt-2">
                <ChangelogList
                    status={status}
                    entries={entries}
                    readSlugs={readSlugs}
                    activeCategory={category}
                    onRetry={retry}
                    onClearFilter={() => changeCategory(null)}
                    onFollowCta={handleFollowCta}
                    trackEntry={tracker.track}
                />
            </div>
        </div>
    );
}
