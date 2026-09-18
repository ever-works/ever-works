'use client';

import { AuthUser } from '@/lib/auth';
import { WorkList } from '@/components/works/WorkList';
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
import { ApprovalsQueue } from '@/components/approvals/ApprovalsQueue';
import { buildDecisionsHref } from '@/lib/api/inbox.shared';
import { HomeMorningStack } from '@/components/home/HomeMorningStack';
import { WorkspaceSection } from '@/components/home/WorkspaceSection';
import { WorkspaceStats } from '@/components/home/WorkspaceStats';
import { glanceForSummary } from '@/components/home/home.shared';
import type { HomeSummaryDto } from '@ever-works/contracts';
import type { Task } from '@/lib/api/tasks';
import type { Agent } from '@/lib/api/agents';
import type { AgentActionProposal } from '@/lib/api/agent-approvals';
import type { AttentionItem, SoonRunItem } from '@/components/dashboard/dashboard-signals.types';

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
    /**
     * `{ [ideaId]: workId }` for Ideas whose title + description match an
     * existing Work — the same backstop `/ideas` uses, resolved server-side
     * in `page.tsx`. Without it the preview can only call an Idea "Built"
     * when `acceptedWorkId` is set, so Ideas built through
     * `/works/new?proposal=…` read "Not built yet" here while showing
     * Built on `/ideas`.
     */
    matchedWorkIds?: Record<string, string>;
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
    /**
     * Agent Action Approval Queue — pending proposals awaiting a
     * human decision. Rendered as an attention block ABOVE Missions
     * when non-empty; the block hides itself once the queue is empty.
     */
    initialApprovals?: AgentActionProposal[];
    /**
     * Dashboard blocks (spec §4.1/§4.5) — new home surfaces. Each is
     * optional with a safe default so existing render paths are
     * unaffected:
     *   - `teamsTotal` — 9th stat tile; `undefined` ⇒ Teams not wired
     *     yet ⇒ tile omitted (PR #1647).
     *   - `attentionItems` — red signal cards ABOVE the Missions list;
     *     empty ⇒ the block (and its divider) render nothing.
     *   - `soonItems` / `soonTotal` — upcoming scheduled runs; empty ⇒
     *     nothing renders (gated on the Schedules front). Superseded on
     *     this page by the morning read's Today block.
     */
    teamsTotal?: number;
    attentionItems?: AttentionItem[];
    soonItems?: SoonRunItem[];
    soonTotal?: number;
    /**
     * Home (AW-19) — the composed morning read. `null` when it could not be
     * read (the stack then says so and the composer still works); omitted
     * entirely by a caller that does not render the morning stack.
     */
    homeSummary?: HomeSummaryDto | null;
    /** From the dashboard layout's health read; `false` = nothing will be dispatched. */
    jobRuntimeConfigured?: boolean | null;
    /**
     * Work-kind chip values whose `works-<value>` PostHog flag resolved to
     * `false`. Passed to the composer's kind chips, exactly as `/new` passes
     * them — resolved server-side by the page.
     */
    disabledKinds?: readonly string[];
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
    matchedWorkIds,
    monthSpendCents = 0,
    monthSpendCurrency = 'usd',
    agentsTotal = 0,
    agentsActive = 0,
    tasksInProgress = 0,
    tasksBlocked = 0,
    initialRecentTasks = [],
    initialAgents = [],
    initialApprovals = [],
    teamsTotal,
    attentionItems = [],
    homeSummary = null,
    jobRuntimeConfigured = null,
    disabledKinds = [],
}: DashboardClientProps) {
    const router = useRouter();
    const t = useTranslations('dashboard');
    const hasWorks = initialWorks.length > 0;

    return (
        <div className="w-full">
            {/* Home (AW-19) — the morning read, in the order the owner set on
                2026-09-18: the composer, `Your workspace` (Today + All), Needs
                you, Working now, Today beside This week, Recent activity. The
                page header is gone: no greeting, no subtitle, no date line. */}
            <HomeMorningStack
                summary={homeSummary}
                attentionItems={attentionItems}
                jobRuntimeConfigured={jobRuntimeConfigured}
                disabledKinds={disabledKinds}
                workspaceStats={
                    <WorkspaceStats
                        glance={glanceForSummary(homeSummary)}
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
                }
            />

            {/* The long tail — everything else Home holds, on demand. */}
            <WorkspaceSection>
                {/* Content sections — divided by a subtle rule for visual rhythm */}
                <div className="divide-y divide-border/30 dark:divide-white/6">
                    {/* Agent Action Approval Queue — attention block above
                    Missions. Self-hides when the queue empties. */}
                    {initialApprovals.length > 0 && (
                        <div className="py-8 lg:py-10">
                            <ApprovalsQueue initialApprovals={initialApprovals} />
                            {/* My Decisions — the same approvals, ranked with every
                            other decision waiting on the owner (questions,
                            escalations) in the Inbox's decision view. */}
                            <Link
                                href={buildDecisionsHref({ tab: 'open' })}
                                className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
                                data-testid="approvals-see-all-decisions"
                            >
                                {t('approvals.seeAll')}
                            </Link>
                        </div>
                    )}
                    {/* Dashboard blocks (spec §4.5) — Attention and Soon moved into
                    the morning stack above: Attention as Needs you's `Also
                    broken`, Soon as the Today panel. */}

                    <div className="py-8 lg:py-10">
                        <MissionsPreviewSection
                            missions={initialMissions}
                            allIdeas={initialAllIdeas}
                        />
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
                            matchedWorkIds={matchedWorkIds}
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
            </WorkspaceSection>
        </div>
    );
}
