'use client';

import { Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeBlock, HomeRecentActivity } from '@ever-works/contracts';
import { FeedRow } from '@/components/feed/FeedRow';
import { feedTargetHref } from '@/components/feed/feed-href';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { HomeBlockShell } from './HomeBlockShell';

/** The Live Feed view of the Activity page. */
export const HOME_FEED_HREF = `${ROUTES.DASHBOARD_ACTIVITY}?view=feed`;

interface RecentActivityBlockProps {
    block: HomeBlock<HomeRecentActivity> | undefined;
    /** The summary's own instant, so relative times match the server render. */
    now: Date;
    onRetry?: () => void;
}

/**
 * Home (AW-19) — the newest entries of the Live Feed, rendered with the feed's
 * own row so a line reads the same here as in the feed, each linking to what
 * it is about, and a link into the full feed.
 */
export function RecentActivityBlock({ block, now, onRetry }: RecentActivityBlockProps) {
    const t = useTranslations('dashboard.home');
    const data = block?.status === 'ok' ? block.data : null;
    const state = !block
        ? 'loading'
        : block.status === 'failed' || !data
          ? 'failed'
          : data.entries.length === 0
            ? 'empty'
            : 'ready';

    return (
        <HomeBlockShell
            blockId="recentActivity"
            title={t('recentActivity.title')}
            icon={Activity}
            state={state}
            failedLabel={t('block.names.recentActivity')}
            onRetry={onRetry}
            skeletonRows={4}
            headerAction={
                <Link href={HOME_FEED_HREF} className="font-medium text-primary hover:underline">
                    {t('recentActivity.openFeed')} →
                </Link>
            }
            empty={
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('recentActivity.empty')}
                </p>
            }
        >
            {data ? (
                <div
                    role="feed"
                    aria-labelledby="home-recentActivity-heading"
                    className="space-y-1"
                >
                    {data.entries.map((entry, index) => (
                        <FeedRow
                            key={entry.id}
                            entry={entry}
                            href={feedTargetHref(entry.target)}
                            position={index + 1}
                            setSize={data.entries.length}
                            now={now}
                        />
                    ))}
                </div>
            ) : null}
        </HomeBlockShell>
    );
}
