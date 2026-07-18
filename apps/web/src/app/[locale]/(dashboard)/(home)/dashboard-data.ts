import 'server-only';

import { serverFetch } from '@/lib/api/server-api';
import { ROUTES } from '@/lib/constants';
import type { Agent } from '@/lib/api/agents';
import type { Task } from '@/lib/api/tasks';
import type { WorkProposal } from '@/lib/api/work-proposals';
import type { AccountWideUsage } from '@/lib/api/usage';
import type { AttentionItem, SoonRunItem } from '@/components/dashboard/dashboard-signals.types';

/**
 * Dashboard blocks (spec §3) — server-side data helpers for the three
 * additive home changes: the Teams count tile, the Attention block,
 * and the Soon block.
 *
 * Every network path here is defensively caught: the Teams and Soon
 * backends land in sibling PRs (Teams #1647, Schedules front), so a
 * 404 must degrade to "omit the tile / render nothing", never a 500
 * bubbling up to the home page (spec §6 — graceful absence).
 */

// The account-budgets settings anchor the Month Spend tile already
// deep-links to; reused for the budget-exceeded Attention card.
const ACCOUNT_BUDGETS_HREF = '/settings/work-agent#account-budgets';

// Cap the Attention list on the dashboard; the rest stays discoverable
// on the entities' own pages (spec §9 Q5 — ~6 on the home surface).
const ATTENTION_MAX = 6;

function pickArray(res: unknown): unknown[] | null {
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object') {
        const obj = res as { data?: unknown; teams?: unknown; items?: unknown };
        if (Array.isArray(obj.data)) return obj.data;
        if (Array.isArray(obj.teams)) return obj.teams;
        if (Array.isArray(obj.items)) return obj.items;
    }
    return null;
}

/**
 * Teams count for the active Organization(s) (spec §3.1, change 1).
 *
 * The Teams API (`/organizations/:orgId/teams`) is NOT on this branch
 * — it ships with the Teams feature (PR #1647). So we probe it: list
 * the user's Organizations (that endpoint IS present), then try each
 * one's `/teams`. The result distinguishes three states:
 *   - `number` — the Teams feature is wired; sum of teams across orgs
 *     (may legitimately be 0 for a user with no teams yet).
 *   - `undefined` — the Teams feature is not wired yet (every probe
 *     404'd) or we couldn't determine it → the tile is omitted.
 *
 * When the org-switcher context lands, narrow this to the active
 * Organization instead of summing across all of them (spec §9 Q2).
 */
export async function getTeamsTotal(): Promise<number | undefined> {
    let orgs: Array<{ id: string }>;
    try {
        const res = await serverFetch<Array<{ id: string }>>('/organizations', { method: 'GET' });
        orgs = Array.isArray(res) ? res : [];
    } catch {
        return undefined;
    }

    // No Organizations → nothing to probe → treat as "not wired" so a
    // bare account doesn't get a permanent "Teams 0" tile.
    if (orgs.length === 0) {
        return undefined;
    }

    let total = 0;
    let anyWired = false;
    for (const org of orgs) {
        try {
            const res = await serverFetch<unknown>(`/organizations/${org.id}/teams`, {
                method: 'GET',
            });
            const arr = pickArray(res);
            // Endpoint responded (feature is wired) — count what we got.
            anyWired = true;
            if (arr) total += arr.length;
        } catch {
            // 404 (endpoint not shipped yet) or a transient failure — skip
            // this org; if EVERY org fails we fall through to `undefined`.
        }
    }

    return anyWired ? total : undefined;
}

/**
 * Upcoming scheduled runs for the Soon block (spec §3.3, change 4).
 *
 * REUSES `GET /api/schedules` from the Schedules front, which does not
 * exist on this branch yet. Until it ships this resolves to an empty
 * set (404 → catch) and the Soon block renders nothing (spec §4.4).
 */
export async function getSoonRuns(): Promise<{ items: SoonRunItem[]; total: number }> {
    try {
        const res = await serverFetch<{ items?: SoonRunItem[]; total?: number }>(
            '/schedules?status=active&sort=nextRunAt:asc&limit=3',
            { method: 'GET' },
        );
        const items = Array.isArray(res?.items) ? res.items : [];
        const total = typeof res?.total === 'number' ? res.total : items.length;
        return { items, total };
    } catch {
        return { items: [], total: 0 };
    }
}

/**
 * Compose the Attention block server-side from data the home page
 * already has (spec §3.2, change 3). Pure + synchronous: all fetches
 * happen up-front in the page's `Promise.all`, so this just shapes and
 * ranks. Danger before warning, then most-recent `occurredAt` first,
 * capped at {@link ATTENTION_MAX}.
 *
 * `task-overdue` is intentionally absent: the Task entity has no
 * `dueDate` on this branch (spec §9 Q3), so only `task-blocked` is
 * surfaced. Schedule-derived signals arrive once the Schedules front
 * feeds them in.
 */
export function composeAttentionItems(input: {
    erroredAgents: Agent[];
    blockedTasks: Task[];
    allIdeas: WorkProposal[];
    accountWide: AccountWideUsage | null;
}): AttentionItem[] {
    const { erroredAgents, blockedTasks, allIdeas, accountWide } = input;
    const items: AttentionItem[] = [];

    // Errored agents — auto-paused after `pauseAfterFailures` (danger).
    for (const agent of erroredAgents) {
        if (agent.status !== 'error') continue;
        items.push({
            id: `agent:${agent.id}`,
            kind: 'agent-error',
            severity: 'danger',
            label: agent.name,
            count: agent.errorCount > 0 ? agent.errorCount : undefined,
            href: ROUTES.DASHBOARD_AGENT(agent.id),
            occurredAt: agent.updatedAt,
        });
    }

    // Failed generations (Ideas that couldn't be built) (warning).
    for (const idea of allIdeas) {
        if (idea.status !== 'failed') continue;
        items.push({
            id: `idea:${idea.id}`,
            kind: 'generation-failed',
            severity: 'warning',
            label: idea.title,
            href: ROUTES.DASHBOARD_IDEA(idea.id),
            occurredAt: idea.generatedAt,
        });
    }

    // Blocked / needs-input tasks (warning).
    for (const task of blockedTasks) {
        if (task.status !== 'blocked') continue;
        items.push({
            id: `task:${task.id}`,
            kind: 'task-blocked',
            severity: 'warning',
            label: task.title,
            href: ROUTES.DASHBOARD_TASK(task.id),
            occurredAt: task.updatedAt,
        });
    }

    // Budget exceeded — account-wide spend has reached the cap. `blocked`
    // (hard stop) reads as danger; over-cap-but-allowed reads as warning.
    if (
        accountWide &&
        accountWide.capCents != null &&
        accountWide.capCents > 0 &&
        accountWide.currentSpendCents >= accountWide.capCents
    ) {
        items.push({
            id: 'budget:account-wide',
            kind: 'budget-exceeded',
            severity: accountWide.blocked ? 'danger' : 'warning',
            href: ACCOUNT_BUDGETS_HREF,
            occurredAt: accountWide.periodEnd,
        });
    }

    const severityRank: Record<AttentionItem['severity'], number> = { danger: 0, warning: 1 };
    items.sort((a, b) => {
        if (severityRank[a.severity] !== severityRank[b.severity]) {
            return severityRank[a.severity] - severityRank[b.severity];
        }
        const at = a.occurredAt ? Date.parse(a.occurredAt) : 0;
        const bt = b.occurredAt ? Date.parse(b.occurredAt) : 0;
        return bt - at;
    });

    return items.slice(0, ATTENTION_MAX);
}
