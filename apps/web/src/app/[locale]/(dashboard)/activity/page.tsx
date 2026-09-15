import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { getActivityLog } from '@/app/actions/activity-log';
import { getFeedActors, getFeedPage } from '@/app/actions/feed';
import { parseFeedFilters } from '@/components/feed/feed-filters';
import { ActivityClient } from './activity-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('activity') };
}

type ActivitySearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

export default async function ActivityPage({
    searchParams,
}: {
    searchParams: ActivitySearchParams;
}) {
    const params = (await searchParams) ?? {};
    // Opened directly on the Live Feed view: render its first page on the
    // server too, for the filters in the URL, so first paint is real entries.
    const feedRequested = firstParam(params.view) === 'feed';
    const feedFilters = feedRequested
        ? parseFeedFilters({
              get: (name) => firstParam(params[name]),
              has: (name) => params[name] !== undefined,
          })
        : null;

    const [response, feedPage, feedActors] = await Promise.all([
        getActivityLog({ limit: 25 }).catch(() => ({
            success: false,
            activities: [],
            total: 0,
        })),
        feedFilters
            ? getFeedPage({
                  agentIds: feedFilters.agentIds,
                  kinds: feedFilters.kinds,
                  failedOnly: feedFilters.failedOnly,
              }).catch(() => null)
            : Promise.resolve(null),
        feedFilters ? getFeedActors().catch(() => null) : Promise.resolve(null),
    ]);

    return (
        <Suspense fallback={null}>
            <ActivityClient
                initialActivities={response.activities}
                totalActivities={response.total}
                initialFeedPage={feedPage?.success ? feedPage.data : null}
                initialFeedActors={feedActors?.success ? feedActors.data.actors : null}
            />
        </Suspense>
    );
}
