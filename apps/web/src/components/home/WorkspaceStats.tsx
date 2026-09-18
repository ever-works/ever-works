'use client';

import { LayoutGrid } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { HomeBlock, HomeGlance } from '@ever-works/contracts';
import { StatsOverview } from '@/components/dashboard/StatsOverview';
import { GlanceCounters } from './GlanceCounters';
import { HomeBlockShell } from './HomeBlockShell';

export interface WorkspaceStatsProps {
    /** The time-bounded counters — the block's `Today` half. */
    glance: HomeBlock<HomeGlance> | undefined;
    totalMissions?: number;
    totalIdeas?: number;
    totalWorks?: number;
    totalItems?: number;
    activeWebsites?: number;
    monthSpendCents?: number;
    monthSpendCurrency?: string;
    agentsTotal?: number;
    agentsActive?: number;
    tasksInProgress?: number;
    tasksBlocked?: number;
    teamsTotal?: number;
    onRetry?: () => void;
}

/**
 * Home (AW-19, owner 2026-09-18) — `Your workspace`, the one stats card the
 * Dashboard opens with.
 *
 * It is the merge the owner asked for: the old `Today at a glance` counters are
 * no longer a block of their own, they are the **Today** half of this card; the
 * account totals that used to sit at the top of the collapsed `Your workspace`
 * region are the **All** half. Two groupings inside one frame, because they
 * answer the same question at two horizons — "what is happening now" versus
 * "what do I have" — and a reader comparing them should not have to scroll
 * between them.
 *
 * Only the `Today` half can fail on its own (it comes from the morning read);
 * the `All` totals are server-rendered page data and are always present. The
 * shell is therefore always `ready`, and the counters own their loading and
 * failed states so a broken read can never pass for a quiet day.
 */
export function WorkspaceStats({
    glance,
    totalMissions,
    totalIdeas,
    totalWorks,
    totalItems,
    activeWebsites,
    monthSpendCents,
    monthSpendCurrency,
    agentsTotal,
    agentsActive,
    tasksInProgress,
    tasksBlocked,
    teamsTotal,
    onRetry,
}: WorkspaceStatsProps) {
    const t = useTranslations('dashboard.home.workspace');

    return (
        <HomeBlockShell
            blockId="workspace"
            title={t('title')}
            icon={LayoutGrid}
            state="ready"
            failedLabel={t('title')}
            onRetry={onRetry}
        >
            <div className="space-y-5">
                <section aria-labelledby="home-workspace-today-heading">
                    <h3
                        id="home-workspace-today-heading"
                        className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted dark:text-text-muted-dark"
                    >
                        {t('today')}
                    </h3>
                    <GlanceCounters block={glance} onRetry={onRetry} />
                </section>

                <section aria-labelledby="home-workspace-all-heading">
                    <h3
                        id="home-workspace-all-heading"
                        className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted dark:text-text-muted-dark"
                    >
                        {t('all')}
                    </h3>
                    <StatsOverview
                        totalMissions={totalMissions}
                        totalIdeas={totalIdeas}
                        totalWorks={totalWorks}
                        totalItems={totalItems}
                        activeWebsites={activeWebsites}
                        monthSpendCents={monthSpendCents}
                        monthSpendCurrency={monthSpendCurrency}
                        agentsTotal={agentsTotal}
                        agentsActive={agentsActive}
                        tasksInProgress={tasksInProgress}
                        tasksBlocked={tasksBlocked}
                        teamsTotal={teamsTotal}
                    />
                </section>
            </div>
        </HomeBlockShell>
    );
}
