import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { agentsAPI } from '@/lib/api/agents';
import { workAPI } from '@/lib/api';
import type { AgentRunSession } from '@/lib/api/agents.shared';
import { AgentsPageTabs } from '@/components/agents/AgentsPageTabs';
import { AgentSessionsClient } from '@/components/agents/AgentSessionsClient';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.agentsPage.sessions');
    return { title: t('title') };
}

/**
 * Run orchestration (Wave 4 M4) — `/agents/sessions`, the Sessions tab
 * under the Agents page: every AgentRun of the acting user across all
 * Agents/Works (`GET /api/agents/runs`), with the Agent/Work id → name
 * maps resolved server-side once. All three fetches are defensive so a
 * flaky API renders the empty state instead of a 500 (same posture as
 * the Agents catalog page).
 */
export default async function AgentSessionsPage() {
    const [sessions, agents, works] = await Promise.all([
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
    ]);

    const agentNames: Record<string, string> = {};
    for (const agent of agents) agentNames[agent.id] = agent.name;
    const workNames: Record<string, string> = {};
    for (const work of works) workNames[work.id] = work.name;

    const t = await getTranslations('dashboard.agentsPage.sessions');

    return (
        <div className="w-full space-y-4">
            <AgentsPageTabs active="sessions" />
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {/* Runs ledger (AW-09) — the same runs on a calendar, with totals. */}
                <Link
                    href={ROUTES.DASHBOARD_RUNS}
                    className="text-xs text-primary hover:underline"
                    data-testid="agent-sessions-open-in-runs"
                >
                    {t('openInRuns')}
                </Link>
            </div>
            <AgentSessionsClient
                initialSessions={sessions}
                agentNames={agentNames}
                workNames={workNames}
            />
        </div>
    );
}
