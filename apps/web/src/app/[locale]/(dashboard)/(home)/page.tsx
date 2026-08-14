import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES, GET_WORK_LIST_LIMIT } from '@/lib/constants';
import DashboardClient from './dashboard-client';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { matchIdeasToWorks } from '@/components/ideas/idea-work-match';
import { workAPI } from '@/lib/api/work';
import { missionsAPI } from '@/lib/api/missions';
import { usageAPI } from '@/lib/api/usage';
// Phase 18.1 — Agent + Task count fetches for the new Dashboard
// tiles. `limit: 1` because we only need `meta.total`; the data array
// isn't rendered (server-side hint at the API tier — same posture as
// the existing Work stats fetch).
import { agentsAPI } from '@/lib/api/agents';
import { tasksAPI } from '@/lib/api/tasks';
import { agentApprovalsAPI } from '@/lib/api/agent-approvals';
// Dashboard blocks (spec §3) — Teams count, Soon runs, and the
// server-composed Attention list. All three degrade gracefully (and log)
// when their backend call fails.
import { composeAttentionItems, getSoonRuns, getTeamsTotal } from './dashboard-data';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

interface DashboardPageProps {
    searchParams: Promise<{ newUser?: string }>;
}

/**
 * How many Works to pull for the title/description match that backstops
 * Idea→Work provenance (`idea-work-match.ts`). Mirrors the same constant
 * on `/ideas`: the two surfaces must match against the SAME candidate
 * pool, otherwise an Idea reads "Built" on one page and "Not built yet"
 * on the other. Deliberately NOT `GET_WORK_LIST_LIMIT` (6) — that list
 * is the 6 Works the dashboard renders, far too narrow a pool to resolve
 * built-ness against.
 */
const MATCH_CANDIDATE_LIMIT = 100;

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
        pendingApprovals,
        // Dashboard blocks (spec §3) — Attention inputs (errored agents +
        // blocked-task rows), the Teams count, and the Soon runs. Every
        // one is catch-defended so a missing/flaky endpoint yields empty
        // signals instead of breaking the home page.
        erroredAgents,
        blockedTaskRows,
        teamsTotal,
        soon,
        matchCandidateWorks,
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
        // Agent Action Approval Queue — pending proposals for the
        // attention block above Missions. Catch-defended so a flaky
        // endpoint hides the block instead of breaking the home page.
        agentApprovalsAPI
            .list({ status: 'pending', limit: 50 })
            .catch(() => ({ data: [], meta: { total: 0, limit: 50, offset: 0 } })),
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
        // Soon runs — the soonest upcoming Work-schedule / Mission runs from
        // the Schedules front's `/api/schedules` aggregation. `getSoonRuns`
        // already logs and absorbs its own transport failures; this catch is
        // the outer belt-and-braces so the home page still renders.
        getSoonRuns().catch(() => ({ items: [], total: 0 })),
        // Match candidates for the Ideas preview's Built badge. The
        // separate `worksResponse` fetch above is capped at the 6 Works
        // the dashboard RENDERS, so it can't serve here. Degraded to `[]`
        // on failure: a flaky /works costs a Built badge, never the page.
        workAPI
            .getAll({ limit: MATCH_CANDIDATE_LIMIT })
            .then((r) => r.works)
            .catch(() => []),
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

    // Built-state backstop for the Ideas preview, resolved exactly as
    // `/ideas` resolves it (same helper, same candidate limit) so an Idea
    // can never read "Built" on one surface and "Not built yet" on the
    // other. Needed because the list endpoint sends no `idea_works`
    // rollup, leaving `acceptedWorkId` — stamped only on a legal
    // transition to ACCEPTED — as the sole provenance signal, which is
    // null for the Works this very card builds via `/works/new?proposal=`.
    const matchedWorkIds = matchIdeasToWorks(allIdeas, matchCandidateWorks);

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
            matchedWorkIds={matchedWorkIds}
            monthSpendCents={accountWide?.currentSpendCents ?? 0}
            monthSpendCurrency={accountWide?.currency ?? 'usd'}
            // Phase 18.1 — Dashboard grid mount.
            agentsTotal={agentsTotal.meta.total}
            agentsActive={agentsActive.meta.total}
            tasksInProgress={tasksInProgress.meta.total}
            tasksBlocked={tasksBlocked.meta.total}
            initialRecentTasks={recentTasks.data ?? []}
            initialAgents={recentAgents.data ?? []}
            initialApprovals={pendingApprovals.data ?? []}
            // Dashboard blocks (spec §3/§4) — Teams tile + Attention/Soon.
            teamsTotal={teamsTotal}
            attentionItems={attentionItems}
            soonItems={soon.items}
            soonTotal={soon.total}
        />
    );
}
