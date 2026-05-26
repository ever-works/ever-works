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
import type { Work } from '@/lib/api';
import type { WorkProposal } from '@/lib/api/work-proposals';
import type { Mission } from '@/lib/api/missions';
// Phase 18.1 — Dashboard grid mount.
import { AgentsCountTile } from '@/components/dashboard/AgentsCountTile';
import { TasksInProgressTile } from '@/components/dashboard/TasksInProgressTile';
import { RecentTasks } from '@/components/dashboard/RecentTasks';
import type { Task } from '@/lib/api/tasks';

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
     */
    agentsTotal?: number;
    agentsActive?: number;
    tasksInProgress?: number;
    tasksBlocked?: number;
    initialRecentTasks?: Task[];
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

            <StatsOverview
                totalMissions={totalMissions}
                totalIdeas={totalIdeas}
                totalWorks={totalWorks}
                totalItems={totalItems}
                activeWebsites={activeWebsites}
                monthSpendCents={monthSpendCents}
                monthSpendCurrency={monthSpendCurrency}
            />

            {/* Phase 18.1 — Agents/Skills/Tasks tiles. Sit between the
                StatsOverview row and the Missions preview so the home
                page reads: stats → AST tiles → Missions → Works.
                Counts come from `meta.total` of the page-level
                list({limit:1}) fetches (cheap). */}
            <div className="grid grid-cols-1 @md/main:grid-cols-2 gap-4 mt-6">
                <AgentsCountTile total={agentsTotal} active={agentsActive} />
                <TasksInProgressTile inProgress={tasksInProgress} blocked={tasksBlocked} />
            </div>

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
                    {hasWorks ? (
                        <>
                            <div className="flex justify-between items-center mb-4">
                                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                                    {t('works.recent')}
                                </h2>
                                {totalWorks > 5 && (
                                    <Link
                                        href={ROUTES.DASHBOARD_WORKS}
                                        className="text-sm text-primary hover:text-primary-hover transition-colors"
                                    >
                                        {t('works.viewAll', { count: totalWorks })}
                                    </Link>
                                )}
                            </div>
                            <WorkList initialWorks={initialWorks} showLimit={GET_WORK_LIST_LIMIT} />
                        </>
                    ) : (
                        <EmptyState
                            title={t('works.empty.title')}
                            description={t('works.empty.description')}
                            action={{
                                label: t('works.empty.action'),
                                onClick: () => {
                                    router.push(ROUTES.DASHBOARD_NEW);
                                },
                            }}
                        />
                    )}
                </div>
            </div>

            {/* Phase 18.2 — Recent Tasks block sits directly below
                Recent Works per spec §18.2. Hidden when there are
                no in-flight Tasks AND no Works (empty new-user state
                already has its own empty CTA from EmptyState above). */}
            {(initialRecentTasks.length > 0 || hasWorks) && (
                <div className="mt-8">
                    <RecentTasks tasks={initialRecentTasks} />
                </div>
            )}
        </div>
    );
}
