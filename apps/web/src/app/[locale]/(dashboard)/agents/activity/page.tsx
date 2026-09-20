import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { RunLedgerPage, RunWindowStats } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { agentsAPI } from '@/lib/api/agents';
import type { AgentRunSession } from '@/lib/api/agents.shared';
import { notificationPreferencesAPI } from '@/lib/api/notification-preferences';
import { runsAPI } from '@/lib/api/runs';
import { workAPI } from '@/lib/api';
import { AgentsPageTabs } from '@/components/agents/AgentsPageTabs';
import { AgentsHubTabs } from '@/components/agents/AgentsHubTabs';
import { AgentsActivityClient } from '@/components/agents/AgentsActivityClient';
import { parseRunsViewState } from '@/components/runs/runs.shared';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.sessions');
    return { title: t('title') };
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Agents hub → Activity (`/agents/activity`) — the AGENT-ONLY Activity view.
 *
 * Renamed and widened from the hub's old "Sessions" tab:
 *
 *  - **Sessions** (default) — every AgentRun of the acting user across all
 *    Agents/Works (`GET /api/agents/runs`), with the Agent/Work id → name maps
 *    resolved server-side once. Unchanged.
 *  - **Ledger** — the Runs page (AW-09) as an agent-scoped view: the same
 *    Day / Week / Month calendar, window totals, search, agent/trigger/outcome
 *    filters and per-run receipts, embedded instead of standing alone.
 *
 * The ledger's server payload is fetched ONLY when the URL names it
 * (`?view=ledger`), so the default Sessions view still costs exactly the three
 * calls it always did.
 *
 * Every read is defensive, so a flaky API renders an empty state instead of a
 * 500 — the same posture as the Agents catalog page.
 */
export default async function AgentsActivityPage({
    searchParams,
}: {
    searchParams?: Promise<SearchParams>;
}) {
    const params = (await searchParams) ?? {};
    const first = (name: string) => {
        const raw = params[name];
        return (Array.isArray(raw) ? raw[0] : raw) ?? null;
    };
    // Off by default: the Sessions view is the landing view and needs none of
    // this, so a plain `/agents/activity` visit issues no ledger calls at all.
    const ledgerRequested = first('view') === 'ledger';
    const runsView = ledgerRequested ? parseRunsViewState({ get: first }) : null;

    const [sessions, agents, works, timeZone] = await Promise.all([
        agentsAPI
            .listSessions({ limit: 100 })
            .then((r) => r.data)
            .catch(() => [] as AgentRunSession[]),
        agentsAPI
            .list({ limit: 200 })
            .then((r) => r.data)
            .catch(() => []),
        workAPI
            .getAll({ limit: 200 })
            .then((r) => r.works)
            .catch(() => []),
        ledgerRequested
            ? notificationPreferencesAPI
                  .getPreferences()
                  .then((prefs) => prefs.preference?.timezone || 'UTC')
                  .catch(() => 'UTC')
            : Promise.resolve('UTC'),
    ]);

    const agentNames: Record<string, string> = {};
    for (const agent of agents) agentNames[agent.id] = agent.name;
    const workNames: Record<string, string> = {};
    for (const work of works) workNames[work.id] = work.name;

    const initialView = runsView ?? parseRunsViewState({ get: () => null });
    let ledgerPage: RunLedgerPage | null = null;
    let ledgerStats: RunWindowStats | null = null;
    if (runsView) {
        const query = {
            granularity: runsView.granularity,
            date: runsView.date ?? undefined,
            timezone: timeZone,
            filters: runsView.filters,
        };
        const [page, stats] = await Promise.allSettled([runsAPI.list(query), runsAPI.stats(query)]);
        ledgerPage = page.status === 'fulfilled' ? page.value : null;
        ledgerStats = stats.status === 'fulfilled' ? stats.value : null;
    }

    const t = await getTranslations('dashboard.agentsPage.sessions');

    return (
        <div className="w-full space-y-4">
            <AgentsPageTabs active="agents" />
            <AgentsHubTabs active="activity" />
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {/* Runs ledger (AW-09) — the same runs in the workspace-wide
                    Activity page's Runs view, beside the operation log. */}
                <Link
                    href={ROUTES.DASHBOARD_ACTIVITY_RUNS}
                    className="text-xs text-primary hover:underline"
                    data-testid="agent-sessions-open-in-runs"
                >
                    {t('openInRuns')}
                </Link>
            </div>
            <AgentsActivityClient
                initialSessions={sessions}
                agentNames={agentNames}
                workNames={workNames}
                runs={{
                    view: initialView,
                    // `view=ledger` without `g` means the viewer's remembered
                    // granularity may apply; with `g`, the URL wins.
                    granularityFromUrl: ledgerRequested && first('g') !== null,
                    timeZone,
                    page: ledgerPage,
                    stats: ledgerStats,
                    agents: agents.map((agent) => ({
                        id: agent.id,
                        name: agent.name,
                        archived: agent.status === 'archived',
                    })),
                }}
            />
        </div>
    );
}
