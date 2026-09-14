import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { RunLedgerPage, RunWindowStats } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { agentsAPI } from '@/lib/api/agents';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';
import { runsAPI } from '@/lib/api/runs';
import { RunsClient } from '@/components/runs/RunsClient';
import { parseRunsViewState } from '@/components/runs/runs.shared';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('runs') };
}

/**
 * Runs ledger (AW-09) — `/runs`: every agent run on a Day / Week / Month
 * calendar, the window's totals beside it, and a receipt per run.
 *
 * A calendar-shaped reader over the same run rows the Sessions tab lists
 * (which keeps working exactly as before and is linked from here). The view
 * lives in the URL; the timezone is the viewer's profile timezone, UTC when
 * the profile has none. The list and the totals are fetched independently
 * with `allSettled`, so one failing never renders the page as an error.
 */
export default async function RunsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const raw = await searchParams;
    const source = {
        get: (name: string) => {
            const value = raw[name];
            return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
        },
    };
    const view = parseRunsViewState(source);

    const timeZone = await notificationPreferencesAPI
        .getPreferences()
        .then((prefs) => prefs.preference?.timezone || 'UTC')
        .catch(() => 'UTC');

    const query = {
        granularity: view.granularity,
        date: view.date ?? undefined,
        timezone: timeZone,
        filters: view.filters,
    };
    const [page, stats, agents] = await Promise.allSettled([
        runsAPI.list(query),
        runsAPI.stats(query),
        agentsAPI.list({ limit: 200 }).then((response) => response.data),
    ]);

    const t = await getTranslations('dashboard.runsPage');

    return (
        <div className="w-full space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                <Link
                    href={ROUTES.DASHBOARD_AGENT_SESSIONS}
                    className="text-xs text-primary hover:underline"
                    data-testid="runs-open-sessions"
                >
                    {t('openSessions')}
                </Link>
            </div>
            <RunsClient
                initialView={view}
                granularityFromUrl={source.get('g') !== null}
                timeZone={timeZone}
                initialPage={page.status === 'fulfilled' ? (page.value as RunLedgerPage) : null}
                initialStats={stats.status === 'fulfilled' ? (stats.value as RunWindowStats) : null}
                agents={
                    agents.status === 'fulfilled'
                        ? agents.value.map((agent) => ({
                              id: agent.id,
                              name: agent.name,
                              archived: agent.status === 'archived',
                          }))
                        : []
                }
            />
        </div>
    );
}
