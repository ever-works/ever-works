import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import type { RunLedgerPage, RunWindowStats } from '@ever-works/contracts';
import { getActivityLog } from '@/app/actions/activity-log';
import { getFeedActors, getFeedPage } from '@/app/actions/feed';
import { getScheduleHealth, getSchedulePage } from '@/app/actions/dashboard/schedules';
import { parseFeedFilters } from '@/components/feed/feed-filters';
import { parseRunsViewState } from '@/components/runs/runs.shared';
import type { RunsAgentOption } from '@/components/runs/RunsFilters';
import {
    EMPTY_SCHEDULE_FILTERS,
    filtersFromSearchParams,
    pageParamsFor,
} from '@/components/schedules/schedules-filters.shared';
import { agentsAPI } from '@/lib/api/agents';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';
import { runsAPI } from '@/lib/api/runs';
import { ActivityClient } from './activity-client';
import { ACTIVITY_VIEW_PARAM, isActivityView } from './activity-views';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('activity') };
}

type ActivitySearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** The incoming query as `URLSearchParams`, so the schedules parser reads
 * exactly what it read when the list was a page of its own. */
function asSearchParams(params: Record<string, string | string[] | undefined>): URLSearchParams {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        const first = firstParam(value);
        if (first !== null) search.set(key, first);
    }
    return search;
}

export default async function ActivityPage({
    searchParams,
}: {
    searchParams: ActivitySearchParams;
}) {
    const params = (await searchParams) ?? {};
    const source = {
        get: (name: string) => firstParam(params[name]),
        has: (name: string) => params[name] !== undefined,
    };
    const view = source.get(ACTIVITY_VIEW_PARAM);
    // Opened directly on a view: render ITS first page on the server too, for
    // the state in the URL, so first paint is real entries and not a spinner.
    const feedRequested = view === 'feed';
    const runsRequested = isActivityView(view) && view === 'runs';
    const schedulesRequested = view === 'schedules';

    const feedFilters = feedRequested ? parseFeedFilters(source) : null;
    // The Runs view's view-state lives in the same address bar, so a shared
    // `/activity?view=runs&g=week&status=failed` link paints that exact window.
    const runsView = runsRequested ? parseRunsViewState(source) : null;
    // …and so do the Schedules view's filters, which are read by the same
    // parser the list used when it was a page of its own.
    const scheduleFilters = schedulesRequested
        ? filtersFromSearchParams(asSearchParams(params))
        : null;

    // The Runs view's CONTEXT — the viewer's timezone and the Agent roster its
    // filter offers — is fetched on every load, not only when the view was
    // asked for in the URL. Both are needed the instant the Runs tab is
    // clicked, and neither can be recovered client-side: the timezone comes
    // from the profile (a server-only read) and a lazily fetched roster would
    // either miss the archived Agents the filter marks, or flash a dropdown
    // that offers nothing but "All agents". They ride in the same parallel
    // batch as everything else, so they cost latency no one waits on.
    const timeZone = notificationPreferencesAPI
        .getPreferences()
        .then((prefs) => prefs.preference?.timezone || 'UTC')
        .catch(() => 'UTC');

    const [response, feedPage, feedActors, resolvedTimeZone, agentRoster, ledger, schedules] =
        await Promise.all([
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
            timeZone,
            agentsAPI
                .list({ limit: 200 })
                .then((r) =>
                    r.data.map<RunsAgentOption>((agent) => ({
                        id: agent.id,
                        name: agent.name,
                        archived: agent.status === 'archived',
                    })),
                )
                .catch(() => [] as RunsAgentOption[]),
            loadLedgerWindow(runsView, runsRequested, timeZone),
            // The Schedules view is the former `/schedules` page, so it is
            // server-rendered for the filters in the link exactly as that page
            // was. Each half fails on its own: a failing list must not blank
            // the health banner and vice versa.
            scheduleFilters
                ? Promise.all([
                      getSchedulePage(pageParamsFor(scheduleFilters)).catch(() => ({
                          ok: false as const,
                      })),
                      getScheduleHealth().catch(() => ({ ok: false as const })),
                  ]).then(([pageResponse, healthResponse]) => ({
                      page: pageResponse.ok ? pageResponse.page : null,
                      failed: !pageResponse.ok,
                      health: healthResponse.ok ? healthResponse.summary : null,
                      healthFailed: !healthResponse.ok,
                  }))
                : Promise.resolve(null),
        ]);

    return (
        <Suspense fallback={null}>
            <ActivityClient
                initialActivities={response.activities}
                totalActivities={response.total}
                initialFeedPage={feedPage?.success ? feedPage.data : null}
                initialFeedActors={feedActors?.success ? feedActors.data.actors : null}
                runs={{
                    view: runsView ?? parseRunsViewState({ get: () => null }),
                    // Only the SERVER can tell "the URL named a granularity"
                    // apart from "the viewer's remembered one applies": after
                    // mount the client has already written `g` back for its own
                    // view, so it must not re-read it.
                    granularityFromUrl: runsRequested && source.get('g') !== null,
                    timeZone: resolvedTimeZone,
                    page: ledger.page,
                    stats: ledger.stats,
                    agents: agentRoster,
                }}
                schedules={{
                    filters: scheduleFilters ?? EMPTY_SCHEDULE_FILTERS,
                    page: schedules?.page ?? null,
                    failed: schedules?.failed ?? false,
                    health: schedules?.health ?? null,
                    healthFailed: schedules?.healthFailed ?? false,
                }}
            />
        </Suspense>
    );
}

/**
 * Runs ledger (AW-09) — the window the Runs view opens on, or an empty frame
 * when the page was not opened on it (the client then fetches on the tab's
 * first activation, exactly as the retired page's own reload did).
 *
 * The list and the rail are read independently: a failing list must not blank
 * the rail, and a failing rail must not blank the list — the same posture the
 * standalone page had.
 *
 * `timeZone` arrives as the in-flight promise the batch above already started,
 * so depending on the profile read costs the ledger no extra round trip.
 */
async function loadLedgerWindow(
    view: ReturnType<typeof parseRunsViewState> | null,
    requested: boolean,
    timeZone: Promise<string>,
): Promise<{ page: RunLedgerPage | null; stats: RunWindowStats | null }> {
    if (!requested || !view) return { page: null, stats: null };
    const query = {
        granularity: view.granularity,
        date: view.date ?? undefined,
        timezone: await timeZone,
        filters: view.filters,
    };
    const [page, stats] = await Promise.allSettled([runsAPI.list(query), runsAPI.stats(query)]);
    return {
        page: page.status === 'fulfilled' ? page.value : null,
        stats: stats.status === 'fulfilled' ? stats.value : null,
    };
}
