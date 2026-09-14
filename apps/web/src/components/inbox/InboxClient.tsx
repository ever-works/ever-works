'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Archive,
    ArchiveRestore,
    Bot,
    CircleAlert,
    Inbox as InboxIcon,
    ListChecks,
    MailOpen,
    MoreVertical,
    ShieldQuestion,
    Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Link, useRouter } from '@/i18n/navigation';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { cn } from '@/lib/utils/cn';
import {
    INBOX_POLL_INTERVAL_MS,
    buildDecisionsHref,
    isAwaitingReply,
    isInboxDecisionKind,
    type InboxItem,
    type InboxItemKind,
    type InboxReplyOutcome,
    type InboxReplyRouted,
} from '@/lib/api/inbox.shared';
import {
    deleteInboxItemAction,
    setInboxItemArchivedAction,
    setInboxItemReadAction,
} from '@/app/actions/dashboard/inbox';
import { InboxAnswerSummary } from './InboxAnswerSummary';
import { InboxFleetSource } from './InboxFleetSource';
import { InboxReplyComposer } from './InboxReplyComposer';
import { InboxTabs, type InboxView } from './InboxTabs';

export type { InboxView };

interface InboxClientProps {
    items: InboxItem[];
    unreadCount: number;
    view: InboxView;
    /** From `?id=` — the deep link a notification's "Open inbox" lands on. */
    selectedId?: string;
    loadError?: string | null;
}

const KIND_ICON: Record<InboxItemKind, typeof Bot> = {
    question: Bot,
    approval: ShieldQuestion,
    escalation: CircleAlert,
    notice: InboxIcon,
};

const KIND_BADGE: Record<InboxItemKind, string> = {
    question:
        'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300 border-blue-200 dark:border-blue-500/25',
    approval:
        'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 border-amber-200 dark:border-amber-500/25',
    escalation:
        'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300 border-red-200 dark:border-red-500/25',
    notice: 'bg-surface-secondary text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark border-border/50 dark:border-white/10',
};

/** First ~140 characters of the body, on one line — the list preview. */
function snippet(body: string): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

/**
 * Inbox (operator message center) — the whole `/inbox` surface.
 *
 * Two panes: the message list (Active / Archived) and the detail with
 * the reply box. One client component rather than three because every
 * interaction crosses the boundary — archiving from a row has to drop it
 * out of the list AND clear the detail if that row was open.
 *
 * Server state is authoritative: each mutation calls its server action
 * (which revalidates the page) and then `router.refresh()`. Local state
 * exists only so the row updates in the same frame as the click. A 30s
 * poll — the notification bell's cadence — pulls in messages that
 * arrived while the tab sat open, and is paused while a reply is in
 * flight so a refresh cannot yank the textarea out from under the human.
 */
export function InboxClient({ items, unreadCount, view, selectedId, loadError }: InboxClientProps) {
    const t = useTranslations('dashboard.inbox');
    const router = useRouter();

    const [rows, setRows] = useState<InboxItem[]>(items);
    const [activeId, setActiveId] = useState<string | null>(
        selectedId && items.some((item) => item.id === selectedId)
            ? selectedId
            : (items[0]?.id ?? null),
    );
    const [busyRowId, setBusyRowId] = useState<string | null>(null);
    const sendingRef = useRef(false);

    // The server is the source of truth for the list; re-sync whenever a
    // refresh (poll, revalidate, tab switch) delivers new rows, and keep
    // the open message selected if it survived.
    useEffect(() => {
        setRows(items);
        setActiveId((current) => {
            if (current && items.some((item) => item.id === current)) return current;
            if (selectedId && items.some((item) => item.id === selectedId)) return selectedId;
            return items[0]?.id ?? null;
        });
    }, [items, selectedId]);

    const active = useMemo(
        () => rows.find((item) => item.id === activeId) ?? null,
        [rows, activeId],
    );

    // The composer resets itself whenever a different message is opened
    // (it is keyed by the item) — carrying half-typed text into someone
    // else's question is the one mistake this surface must not make.

    useEffect(() => {
        const timer = setInterval(() => {
            if (sendingRef.current) return;
            router.refresh();
        }, INBOX_POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [router]);

    const markRead = useCallback(
        async (id: string) => {
            setRows((prev) =>
                prev.map((item) => (item.id === id ? { ...item, unread: false } : item)),
            );
            try {
                await setInboxItemReadAction(id, false);
            } catch {
                // A failed read-flip is cosmetic; the next poll re-syncs.
            }
        },
        [setRows],
    );

    const handleOpen = useCallback(
        (item: InboxItem) => {
            setActiveId(item.id);
            if (item.unread) void markRead(item.id);
        },
        [markRead],
    );

    const handleToggleRead = useCallback(
        async (item: InboxItem) => {
            const next = !item.unread;
            setRows((prev) =>
                prev.map((row) => (row.id === item.id ? { ...row, unread: next } : row)),
            );
            try {
                await setInboxItemReadAction(item.id, next);
                router.refresh();
            } catch {
                toast.error(t('toast.error'));
                router.refresh();
            }
        },
        [router, t],
    );

    const handleArchive = useCallback(
        async (item: InboxItem, archived: boolean) => {
            setBusyRowId(item.id);
            // The row leaves whichever tab is open either way: archiving
            // drops it out of Active, restoring drops it out of Archived.
            setRows((prev) => prev.filter((row) => row.id !== item.id));
            try {
                await setInboxItemArchivedAction(item.id, archived);
                toast.success(archived ? t('toast.archived') : t('toast.unarchived'));
                router.refresh();
            } catch {
                toast.error(t('toast.error'));
                router.refresh();
            } finally {
                setBusyRowId(null);
            }
        },
        [router, t],
    );

    const handleDelete = useCallback(
        async (item: InboxItem) => {
            setBusyRowId(item.id);
            setRows((prev) => prev.filter((row) => row.id !== item.id));
            try {
                await deleteInboxItemAction(item.id);
                toast.success(t('toast.deleted'));
                router.refresh();
            } catch {
                toast.error(t('toast.error'));
                router.refresh();
            } finally {
                setBusyRowId(null);
            }
        },
        [router, t],
    );

    const handleSendingChange = useCallback((sending: boolean) => {
        sendingRef.current = sending;
    }, []);

    const handleReplied = useCallback(
        (outcome: InboxReplyOutcome) => {
            setRows((prev) => prev.map((row) => (row.id === outcome.item.id ? outcome.item : row)));
            toast.success(t(ROUTED_MESSAGE_KEY[outcome.routed] ?? ROUTED_MESSAGE_KEY.none));
            router.refresh();
        },
        [router, t],
    );

    return (
        <div className="p-4 sm:p-6 lg:p-8" data-testid="inbox-page">
            <header className="mb-6 flex items-center justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {unreadCount > 0 && (
                    <span
                        className="shrink-0 rounded-full bg-blue-600 text-white text-xs font-medium px-2.5 py-1"
                        data-testid="inbox-unread-count"
                    >
                        {t('unreadCount', { count: unreadCount })}
                    </span>
                )}
            </header>

            <InboxTabs view={view} />

            {loadError && (
                <div className="mb-4 rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-300">
                    {loadError}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-4">
                <ul
                    className="rounded-xl border border-border dark:border-border-dark divide-y divide-border dark:divide-border-dark overflow-hidden"
                    data-testid="inbox-list"
                >
                    {rows.length === 0 && (
                        <li className="p-8 text-center text-sm text-text-secondary dark:text-text-secondary-dark">
                            {view === 'archived' ? t('empty.archived') : t('empty.active')}
                        </li>
                    )}
                    {rows.map((item) => {
                        const Icon = KIND_ICON[item.kind];
                        return (
                            <li key={item.id} className="relative">
                                <button
                                    type="button"
                                    onClick={() => handleOpen(item)}
                                    disabled={busyRowId === item.id}
                                    aria-current={item.id === activeId}
                                    data-testid="inbox-row"
                                    className={cn(
                                        'w-full text-left px-4 py-3 pr-10 transition-colors',
                                        item.id === activeId
                                            ? 'bg-surface-secondary dark:bg-card-secondary-dark'
                                            : 'hover:bg-surface-secondary dark:hover:bg-card-primary-dark',
                                    )}
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        {item.unread && (
                                            <span
                                                className="shrink-0 w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400"
                                                aria-label={t('unreadDot')}
                                            />
                                        )}
                                        <Icon className="shrink-0 w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                                        <span
                                            className={cn(
                                                'truncate text-sm',
                                                item.unread
                                                    ? 'font-semibold text-text dark:text-text-dark'
                                                    : 'text-text dark:text-text-secondary-dark',
                                            )}
                                        >
                                            {item.title}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark line-clamp-2">
                                        {snippet(item.body)}
                                    </p>
                                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                        <span
                                            className={cn(
                                                'rounded-full border px-1.5 py-0.5',
                                                KIND_BADGE[item.kind],
                                            )}
                                        >
                                            {t(`kind.${item.kind}`)}
                                        </span>
                                        {/* Slice Q — "From your fleet" chip on a question
                                            a run on the owner's own machine asked. */}
                                        <InboxFleetSource item={item} compact />
                                        <ShowDateTime value={item.createdAt} />
                                    </div>
                                </button>
                                <div className="absolute top-2 right-1">
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label={t('rowMenu.label')}
                                                data-testid="inbox-row-menu"
                                                className="p-1.5 rounded-md text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-white/6"
                                            >
                                                <MoreVertical className="w-4 h-4" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                onClick={() => void handleToggleRead(item)}
                                            >
                                                <MailOpen className="w-4 h-4" />
                                                {item.unread
                                                    ? t('rowMenu.markRead')
                                                    : t('rowMenu.markUnread')}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    void handleArchive(item, view !== 'archived')
                                                }
                                            >
                                                {view === 'archived' ? (
                                                    <ArchiveRestore className="w-4 h-4" />
                                                ) : (
                                                    <Archive className="w-4 h-4" />
                                                )}
                                                {view === 'archived'
                                                    ? t('rowMenu.unarchive')
                                                    : t('rowMenu.archive')}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onClick={() => void handleDelete(item)}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                {t('rowMenu.delete')}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </li>
                        );
                    })}
                </ul>

                <section
                    className="rounded-xl border border-border dark:border-border-dark p-5 min-h-[20rem]"
                    data-testid="inbox-detail"
                >
                    {!active ? (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('detail.none')}
                        </p>
                    ) : (
                        <div className="space-y-5">
                            <div>
                                <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                                    {active.title}
                                </h2>
                                <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {t(`kind.${active.kind}`)} ·{' '}
                                    <ShowDateTime value={active.createdAt} />
                                </p>
                                {/* Slice Q — node / Task / branch a fleet question came
                                    from. The reply box below is the same one a cloud
                                    question uses: the answer resumes the parked run on
                                    that branch. */}
                                <InboxFleetSource item={active} />
                            </div>

                            {isAwaitingReply(active) && (
                                <div
                                    className="rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
                                    data-testid="inbox-waiting-banner"
                                >
                                    {t('detail.waitingBanner')}
                                </div>
                            )}

                            <p className="whitespace-pre-wrap text-sm text-text dark:text-text-dark">
                                {active.body}
                            </p>

                            {active.status !== 'open' && <InboxAnswerSummary item={active} />}

                            {active.status === 'open' && (
                                <InboxReplyComposer
                                    key={active.id}
                                    item={active}
                                    onSendingChange={handleSendingChange}
                                    onReplied={handleReplied}
                                />
                            )}

                            {/* My Decisions — the same item, read with what is
                                waiting behind it and ranked against every other
                                decision. Notices are not decisions. */}
                            {isInboxDecisionKind(active.kind) && (
                                <Link
                                    href={buildDecisionsHref(
                                        { tab: active.status === 'open' ? 'open' : active.status },
                                        active.id,
                                    )}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                                    data-testid="inbox-open-in-decisions"
                                >
                                    <ListChecks className="w-3.5 h-3.5" />
                                    {t('detail.openInDecisions')}
                                </Link>
                            )}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

/**
 * The API's routing verdict → the sentence the human reads. "Sent" is
 * not good enough here: "the running agent picked it up" and "a new run
 * is answering it" are materially different outcomes, and
 * `already-decided` means the reply changed nothing at all.
 */
const ROUTED_MESSAGE_KEY = {
    steered: 'routed.steered',
    resumed: 'routed.resumed',
    approved: 'routed.approved',
    rejected: 'routed.rejected',
    'escalation-resolved': 'routed.escalationResolved',
    'already-decided': 'routed.alreadyDecided',
    none: 'routed.recorded',
} as const satisfies Record<InboxReplyRouted, string>;
