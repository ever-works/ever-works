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
            {/* Page header */}
            <div className="mb-10">
                <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                    {t('header.welcome', { username: user.username })}
                </h1>
                <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                    {t('header.subtitle')}
                </p>
            </div>

            {/* Stats strip */}
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

            {/* Content sections — divided by a subtle rule for visual rhythm */}
            <div className="mt-10 divide-y divide-border/30 dark:divide-white/6">
                <div className="py-8 lg:py-10">
                    <MissionsPreviewSection missions={initialMissions} allIdeas={initialAllIdeas} />
                </div>

                <div className="py-8">
                    <WorkProposalsSection
                        // Home shows Ideas of every status (page.tsx feeds the
                        // all-status list here) so a manually-created Idea is
                        // visible regardless of its status — `showAllStatuses`
                        // starts the accepted/dismissed toggles ON.
                        initialProposals={initialProposals}
                        initiallyResearching={initiallyResearching}
                        initiallyCanRefresh={initiallyCanRefresh}
                        username={user.username}
                        autoStart={autoStartProposals}
                        totalIdeas={totalIdeas}
                        showAllStatuses
                    />
                </div>

                <div className="py-8 lg:py-10">
                    <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                                <FolderKanban className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                            </div>
                            <h2 className="text-xl font-semibold text-text dark:text-text-dark truncate">
                                {t('works.recent')}
                            </h2>
                        </div>
                        <div className="flex flex-nowrap items-center gap-2 shrink-0">
                            <Link
                                href="/new?type=website"
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-150 whitespace-nowrap',
                                    'border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark',
                                    'text-text-secondary dark:text-text-secondary-dark',
                                    'hover:border-border dark:hover:border-white/16',
                                )}
                            >
                                <Plus className="w-3.5 h-3.5" />
                                {t('works.add')}
                            </Link>
                            {totalWorks > 5 && (
                                <Link
                                    href={ROUTES.DASHBOARD_WORKS}
                                    className="text-xs font-medium text-primary hover:underline whitespace-nowrap"
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

                <div className="py-8 lg:py-10">
                    <RecentTasks tasks={initialRecentTasks} total={tasksInProgress} />
                </div>

                <div className="py-8 lg:py-10">
                    <AgentsPreviewSection agents={initialAgents} totalAgents={agentsTotal} />
                </div>
            </div>
        </div>
    );
}
