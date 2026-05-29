'use client';

import { AuthUser } from '@/lib/auth';
import { WorkList } from '@/components/works/WorkList';
import { StatsOverview } from '@/components/dashboard/StatsOverview';
import { WorkProposalsSection } from '@/components/dashboard/WorkProposalsSection';
import { MissionsPreviewSection } from '@/components/missions';
import { EmptyState } from '@/components/common/EmptyState';
import { GET_WORK_LIST_LIMIT, ROUTES } from '@/lib/constants';
import { Link, useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { FolderKanban, Plus } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { Work } from '@/lib/api';
import type { WorkProposal } from '@/lib/api/work-proposals';
import type { Mission } from '@/lib/api/missions';
import { RecentTasks } from '@/components/dashboard/RecentTasks';
import { AgentsPreviewSection } from '@/components/dashboard/AgentsPreviewSection';
import type { Task } from '@/lib/api/tasks';
import type { Agent } from '@/lib/api/agents';

interface DashboardClientProps {
    user: AuthUser;
    initialWorks: Work[];
    totalWorks: number;
    totalItems: number;
    activeWebsites: number;
    /** Phase 2 PR F — Dashboard tiles for Missions/Ideas/Works v6 spec §5.1. */
    totalMissions: number;
    totalIdeas: number;
    initialProposals: WorkProposal[];
    initiallyResearching: boolean;
    initiallyCanRefresh: boolean;
    autoStartProposals: boolean;
    /** Phase 6 PR S - Missions preview block. */
    initialMissions: Mission[];
    initialAllIdeas: WorkProposal[];
    /** Phase 7 PR II - account-wide spend for the 6th dashboard tile. */
    monthSpendCents?: number;
    monthSpendCurrency?: string;
    /**
     * Phase 18.1 — Agents/Skills/Tasks dashboard tiles. All counts
     * default to 0 so the props remain backwards-compatible if a
     * page-level fetch fails — the tiles just show zeros instead of
     * disappearing.
     *
     * Dashboard polish (2026-05-27) — Agents + Tasks counts now feed
     * the unified StatsOverview grid; the separate two-tile row from
     * Phase 18.1 was removed. The counts themselves are still passed
     * through unchanged.
     */
    agentsTotal?: number;
    agentsActive?: number;
    tasksInProgress?: number;
    tasksBlocked?: number;
    initialRecentTasks?: Task[];
    /** Dashboard polish (2026-05-27) — recent Agents for the new
     *  Agents preview section that sits below Tasks. */
    initialAgents?: Agent[];
}

export default function DashboardClient({
    user,
    initialWorks,
    totalWorks,
    totalItems,
    activeWebsites,
    totalMissions,
    totalIdeas,
    initialProposals,
    initiallyResearching,
    initiallyCanRefresh,
    autoStartProposals,
    initialMissions,
    initialAllIdeas,
    monthSpendCents = 0,
    monthSpendCurrency = 'usd',
    agentsTotal = 0,
    agentsActive = 0,
    tasksInProgress = 0,
    tasksBlocked = 0,
    initialRecentTasks = [],
    initialAgents = [],
}: DashboardClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard');
    const hasWorks = initialWorks.length > 0;

    return (
        <div className="w-full">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                    {t('header.welcome', { username: user.username })}
                </h1>
                <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                    {t('header.subtitle')}
                </p>
            </div>

            {/* Dashboard polish (2026-05-27) — single grid of 8 tiles.
                Agents + Tasks-in-flight moved into StatsOverview so the
                whole strip collapses to one row when the chat panel is
                hidden (`@7xl/main:grid-cols-8`). */}
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
            />

            {/* Phase 6 PR S — Missions preview ABOVE Ideas so the home
                page reads Missions → Ideas → Works in the same
                direction as the stats tiles + sidebar nav. */}
            <MissionsPreviewSection missions={initialMissions} allIdeas={initialAllIdeas} />

            <WorkProposalsSection
                initialProposals={initialProposals}
                initiallyResearching={initiallyResearching}
                initiallyCanRefresh={initiallyCanRefresh}
                username={user.username}
                autoStart={autoStartProposals}
            />

            <div className="grid grid-cols-1 @3xl/main:grid-cols-3 gap-8 mt-8">
                <div className="@3xl/main:col-span-3">
                    {/* Dashboard polish (2026-05-27) — header is always
                        rendered (outside the `hasWorks ?` branch) so the
                        `+ Add` button stays visible for users with zero
                        Works, matching every other section on the page.
                        `+ Add` routes to `/new?type=website` (the
                        unified chip entry point with a Work shape pre-
                        selected) so the user lands in a Work-creation
                        surface — `/works/new` without `mode` or
                        `proposal` redirects back to `/new` and would
                        otherwise default to Mission/Idea. */}
                    <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="shrink-0 w-9 h-9 rounded-lg bg-concept-works/10 border border-concept-works/20 flex items-center justify-center">
                                <FolderKanban className="w-4 h-4 text-concept-works" />
                            </div>
                            <h2 className="text-xl font-semibold text-text dark:text-text-dark truncate">
                                {t('works.recent')}
                            </h2>
                        </div>
                        <div className="flex flex-nowrap items-center gap-2 shrink-0">
                            <Link
                                href="/new?type=website"
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap',
                                    'border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark',
                                    'text-text-secondary dark:text-text-secondary-dark',
                                    'hover:border-primary/40 hover:text-primary',
                                )}
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Add
                            </Link>
                            {totalWorks > 5 && (
                                <Link
                                    href={ROUTES.DASHBOARD_WORKS}
                                    className="text-sm font-medium text-primary hover:underline whitespace-nowrap"
                                >
                                    {t('works.viewAll', { count: totalWorks })}
                                </Link>
                            )}
                        </div>
                    </div>
                    {hasWorks ? (
                        <WorkList initialWorks={initialWorks} showLimit={GET_WORK_LIST_LIMIT} />
                    ) : (
                        <EmptyState
                            title={t('works.empty.title')}
                            description={t('works.empty.description')}
                            action={{
                                label: t('works.empty.action'),
                                onClick: () => {
                                    router.push('/new?type=website');
                                },
                            }}
                        />
                    )}
                </div>
            </div>

            {/* Phase 18.2 — Tasks block sits directly below Recent
                Works. Dashboard polish (2026-05-27) — always render
                so the dashboard reads Missions → Ideas → Works →
                Tasks → Agents in a consistent strip even on a
                brand-new account; the section's own empty state
                handles the "no Tasks yet" copy. */}
            <RecentTasks tasks={initialRecentTasks} total={tasksInProgress} />

            {/* Dashboard polish (2026-05-27) — Agents preview below
                Tasks. Same shape as the other sections so the user
                sees the same icon-title-actions-grid rhythm. */}
            <AgentsPreviewSection agents={initialAgents} totalAgents={agentsTotal} />
        </div>
    );
}
