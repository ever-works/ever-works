'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarRange, ListChecks } from 'lucide-react';
import type { AgentRunSession } from '@/lib/api/agents.shared';
import { AgentSessionsClient } from '@/components/agents/AgentSessionsClient';
import { RunsClient } from '@/components/runs/RunsClient';
import { buildRunsSearch, type RunsViewState } from '@/components/runs/runs.shared';
import type { RunsAgentOption } from '@/components/runs/RunsFilters';
import type { RunLedgerPage, RunWindowStats } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/** The server-rendered ledger payload, or its empty frame. */
export interface AgentsActivityRunsPayload {
    view: RunsViewState;
    granularityFromUrl: boolean;
    timeZone: string;
    page: RunLedgerPage | null;
    stats: RunWindowStats | null;
    agents: RunsAgentOption[];
}

const VIEWS = ['sessions', 'ledger'] as const;
type AgentsActivityView = (typeof VIEWS)[number];

function isView(value: string | null): value is AgentsActivityView {
    return value != null && (VIEWS as readonly string[]).includes(value);
}

/**
 * Agents hub → Activity — the AGENT-ONLY twin of the global Activity page.
 *
 * Two views over the same `agent_runs` rows, because the two questions people
 * ask about a fleet are different questions:
 *
 *  - **Sessions** (default) — the live fleet: status, what each run is doing
 *    right now, gate chips, tokens, cost, "Attach" into the run's terminal,
 *    grouped by Work. This is the tab that used to be called "Sessions".
 *  - **Ledger** — the same runs on a Day / Week / Month calendar with the
 *    window's totals, search, agent / trigger / outcome filters and a receipt
 *    per run. This is the Runs page (AW-09) rendered where an agent-scoped
 *    ledger belongs; the global Activity page hosts the identical ledger
 *    beside the operation log.
 *
 * Nothing about either view is reimplemented here: Sessions is the same
 * `AgentSessionsClient`, Ledger is the same `RunsClient`. What this component
 * adds is the switch between them and — because a page that hosts several
 * views has exactly one writer for its address bar — the URL mirror the ledger
 * would otherwise have done for itself.
 */
export function AgentsActivityClient({
    initialSessions,
    agentNames,
    workNames,
    runs,
}: {
    initialSessions: AgentRunSession[];
    /** id → display name maps, server-resolved once. */
    agentNames: Record<string, string>;
    workNames: Record<string, string>;
    runs: AgentsActivityRunsPayload;
}) {
    const t = useTranslations('dashboard.agentsPage.sessions');
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    const [view, setView] = useState<AgentsActivityView>(() => {
        const fromUrl = searchParams.get('view');
        return isView(fromUrl) ? fromUrl : 'sessions';
    });
    const [runsView, setRunsView] = useState<RunsViewState>(runs.view);
    const runsSearchRef = useRef<HTMLInputElement>(null);
    const mounted = useRef(false);

    // Mirror the active view into the URL. Only the ACTIVE view's parameters
    // are written, so the ledger's `status`/`agent`/`kind` can never be read
    // back as anything else (and vice versa).
    useEffect(() => {
        if (!mounted.current) {
            mounted.current = true;
            return;
        }
        if (view === 'ledger') {
            // Same same-document write the ledger uses on its own page: a
            // `router.replace` here would ask for a server render of this page
            // that nothing uses, and trail every arrow key.
            const query = buildRunsSearch(runsView);
            window.history.replaceState(
                null,
                '',
                `${window.location.pathname}?view=ledger${query ? `&${query}` : ''}`,
            );
            return;
        }
        router.replace(pathname, { scroll: false });
    }, [view, runsView, pathname, router]);

    // The ledger keeps its own keyboard layer here — `/` to focus its search,
    // `?` to open its sheet, `←/→ d w m t j k Enter Esc` on the window — because
    // it is the only keyed surface on this page. The host therefore stays out of
    // the keyboard entirely: two handlers for one key is how a page ends up
    // focusing a box twice or opening two sheets.

    const tabs = [
        { key: 'sessions' as const, icon: ListChecks, label: t('viewToggle.sessions') },
        { key: 'ledger' as const, icon: CalendarRange, label: t('viewToggle.ledger') },
    ];

    return (
        <div className="space-y-4">
            <div
                data-testid="agents-activity-view-toggle"
                className="flex items-center gap-0.5 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-0.5 w-fit"
            >
                {tabs.map((tab) => {
                    const Icon = tab.icon;
                    const active = view === tab.key;
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setView(tab.key)}
                            aria-pressed={active}
                            aria-label={tab.label}
                            data-testid={`agents-activity-view-${tab.key}`}
                            className={cn(
                                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all duration-150',
                                active
                                    ? 'bg-card dark:bg-card-primary-dark text-text dark:text-text-dark shadow-sm'
                                    : 'text-text-muted dark:text-text-muted-dark hover:text-text-secondary dark:hover:text-text-secondary-dark',
                            )}
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {view === 'sessions' ? (
                <AgentSessionsClient
                    initialSessions={initialSessions}
                    agentNames={agentNames}
                    workNames={workNames}
                />
            ) : (
                <RunsClient
                    initialView={runsView}
                    granularityFromUrl={runs.granularityFromUrl}
                    timeZone={runs.timeZone}
                    initialPage={runs.page}
                    initialStats={runs.stats}
                    agents={runs.agents}
                    syncUrl={false}
                    onViewChange={setRunsView}
                    searchRef={runsSearchRef}
                />
            )}
        </div>
    );
}
