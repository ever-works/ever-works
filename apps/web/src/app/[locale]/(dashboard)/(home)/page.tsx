import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES, GET_WORK_LIST_LIMIT } from '@/lib/constants';
import DashboardClient from './dashboard-client';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { missionsAPI } from '@/lib/api/missions';
import { usageAPI } from '@/lib/api/usage';
// Phase 18.1 — Agent + Task count fetches for the new Dashboard
// tiles. `limit: 1` because we only need `meta.total`; the data array
// isn't rendered (server-side hint at the API tier — same posture as
// the existing Work stats fetch).
import { agentsAPI } from '@/lib/api/agents';
import { tasksAPI } from '@/lib/api/tasks';
// Dashboard blocks (spec §3) — Teams count, Soon runs, and the
// server-composed Attention list. All three degrade gracefully when
// their sibling-PR backends (Teams #1647, Schedules front) are absent.
import { composeAttentionItems, getSoonRuns, getTeamsTotal } from './dashboard-data';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

interface DashboardPageProps {
    searchParams: Promise<{ newUser?: string }>;
}

export default async function Dashboard({ searchParams }: DashboardPageProps) {
    const [
        { newUser },
        user,
        worksResponse,
        statsResponse,
        proposals,
        proposalsStatus,
        missions,
        allIdeas,
        accountWide,
        // Phase 18.1 — Agent + Task counts + 5 most-recent in-flight
        // Tasks. All catch-defended so a flaky endpoint shows zeros
        // instead of breaking the home page.
        agentsTotal,
        agentsActive,
        tasksInProgress,
        tasksBlocked,
        recentTasks,
        recentAgents,
        // Dashboard blocks (spec §3) — Attention inputs (errored agents +
        // blocked-task rows), the Teams count, and the Soon runs. Every
        // one is catch-defended so a missing/flaky endpoint yields empty
        // signals instead of breaking the home page.
        erroredAgents,
        blockedTaskRows,
        teamsTotal,
        soon,
    ] = await Promise.all([
        searchParams,
        getAuthFromCookie(),
        getWorks({ limit: GET_WORK_LIST_LIMIT }).catch(() => ({
            success: false,
            works: [],
            total: 0,
        })),
        getWorkStats().catch(() => ({
            success: false,
            totalWorks: 0,
            totalItems: 0,
            activeWebsites: 0,
            totalMissions: 0,
            totalIdeas: 0,
        })),
        workProposalsAPI.list(['pending']).catch(() => []),
        workProposalsAPI.status().catch(() => ({ researching: false, canRefresh: true }) as const),
        missionsAPI.list().catch(() => []),
        workProposalsAPI
            .list(['pending', 'queued', 'building', 'failed', 'accepted', 'dismissed'])
            .catch(() => []),
        usageAPI.accountWide().catch(() => null),
        agentsAPI
            .list({ limit: 1 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 1, offset: 0 } })),
        agentsAPI
            .list({ status: 'active', limit: 1 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 1, offset: 0 } })),
        tasksAPI
            .list({ status: ['todo', 'in_progress', 'in_review'] as any, limit: 1 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 1, offset: 0 } })),
        tasksAPI
            .list({ status: 'blocked' as any, limit: 1 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 1, offset: 0 } })),
        tasksAPI
            .list({ status: ['todo', 'in_progress', 'in_review', 'blocked'] as any, limit: 5 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 5, offset: 0 } })),
        // Dashboard polish (2026-05-27) — recent Agents for the new
        // preview section below Tasks. Same shape as `missions`:
        // server-fetched up-front so the section can render without
        // a client-side round-trip.
        agentsAPI
            .list({ limit: 3 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 3, offset: 0 } })),
        // Dashboard blocks — errored agents (Attention: agent-error).
        agentsAPI
            .list({ status: 'error', limit: 6 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 6, offset: 0 } })),
        // Blocked-task ROWS (Attention: task-blocked) — the count-only
        // `tasksBlocked` fetch above stays for the stat tile.
        tasksAPI
            .list({ status: 'blocked' as any, limit: 6 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 6, offset: 0 } })),
        // Teams count (9th tile) — `undefined` until Teams (PR #1647) wires it.
        getTeamsTotal().catch(() => undefined),
        // Soon runs — empty until the Schedules front ships `/api/schedules`.
        getSoonRuns().catch(() => ({ items: [], total: 0 })),
    ]);

    // Security: defense-in-depth guard — if middleware matcher is misconfigured and
    // an unauthenticated request reaches this server component, redirect to login
    // rather than throwing a TypeError from the non-null assertion on line below.
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const totalWorks = statsResponse.success ? statsResponse.totalWorks : worksResponse.total;

    // Dashboard blocks (spec §3.2) — compose the Attention list from
    // signals the page already has: errored agents, failed generations
    // (the all-status Ideas list), blocked tasks, and the account-wide
    // budget. Pure/synchronous — all fetches happened above in parallel.
    const attentionItems = composeAttentionItems({
        erroredAgents: erroredAgents.data ?? [],
        blockedTasks: blockedTaskRows.data ?? [],
        allIdeas,
        accountWide,
    });

    return (
        <DashboardClient
            user={user!}
            initialWorks={worksResponse.works}
            totalWorks={totalWorks}
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
            totalMissions={statsResponse.totalMissions ?? 0}
            totalIdeas={statsResponse.totalIdeas ?? 0}
            initialProposals={allIdeas}
            initiallyResearching={proposalsStatus.researching}
            initiallyCanRefresh={proposalsStatus.canRefresh}
            autoStartProposals={newUser === 'true' && proposals.length === 0}
            initialMissions={missions}
            initialAllIdeas={allIdeas}
            monthSpendCents={accountWide?.currentSpendCents ?? 0}
            monthSpendCurrency={accountWide?.currency ?? 'usd'}
            // Phase 18.1 — Dashboard grid mount.
            agentsTotal={agentsTotal.meta.total}
            agentsActive={agentsActive.meta.total}
            tasksInProgress={tasksInProgress.meta.total}
            tasksBlocked={tasksBlocked.meta.total}
            initialRecentTasks={recentTasks.data ?? []}
            initialAgents={recentAgents.data ?? []}
            // Dashboard blocks (spec §3/§4) — Teams tile + Attention/Soon.
            teamsTotal={teamsTotal}
            attentionItems={attentionItems}
            soonItems={soon.items}
            soonTotal={soon.total}
        />
    );
}
