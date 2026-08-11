import 'server-only';

import { serverFetch } from '@/lib/api/server-api';
import { schedulesAPI, type ScheduleEntry } from '@/lib/api/schedules';
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
 * Every network path here is defensively caught so a failing or absent
 * backend degrades to "omit the tile / render nothing" rather than
 * 500-ing the home page (spec §6 — graceful absence). Degrading is not
 * the same as staying silent: each catch logs which call failed, because
 * a swallowed error here is invisible by construction — the block it
 * feeds renders nothing when it has no data, which looks identical to a
 * healthy-but-quiet dashboard.
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
    } catch (error) {
        console.error('[dashboard] Teams tile: GET /api/organizations failed', error);
        return undefined;
    }

    // No Organizations → nothing to probe → treat as "not wired" so a
    // bare account doesn't get a permanent "Teams 0" tile.
    if (orgs.length === 0) {
        return undefined;
    }

    // Probe every org's `/teams` concurrently — they're independent, so
    // there's no reason to pay the round-trips sequentially.
    const results = await Promise.allSettled(
        orgs.map((org) =>
            serverFetch<unknown>(`/organizations/${org.id}/teams`, { method: 'GET' }),
        ),
    );

    let total = 0;
    let anyWired = false;
    for (const result of results) {
        // A rejection is a 404 (endpoint not shipped yet) or a transient
        // failure — skip that org; if EVERY probe fails we fall through to
        // `undefined`.
        if (result.status !== 'fulfilled') continue;
        const arr = pickArray(result.value);
        // Endpoint responded (feature is wired) — count what we got.
        anyWired = true;
        if (arr) total += arr.length;
    }

    return anyWired ? total : undefined;
}

// The Soon block previews the soonest few runs; `total` still counts every
// upcoming run so SoonSection can render its "+N more" link (spec §4.4).
const SOON_MAX = 3;

/**
 * `GET /api/schedules` projects seven scheduled sources, but `SoonRunItem`
 * models exactly two kinds — Work schedules and Mission ticks (dashboard-blocks
 * spec §2.2), and `SoonSection` only has badge copy for those two
 * (`dashboard.soon.source.{work,mission}`). Rows from the other five sources
 * are skipped rather than mislabelled as one of these; widening the block to
 * cover them is a product change (a new badge string in all 21 locale files),
 * not part of this fix.
 */
const SOON_SOURCE_KINDS: Partial<Record<ScheduleEntry['sourceType'], SoonRunItem['sourceKind']>> = {
    work_schedule: 'work-schedule',
    mission_tick: 'mission',
};

/**
 * Upcoming scheduled runs for the Soon block (spec §3.3, change 4).
 *
 * REUSES `GET /api/schedules` from the Schedules front, via the same typed
 * client (`schedulesAPI`) the Schedules view itself uses.
 *
 * The dashboard-blocks spec sketched this call as
 * `?status=active&sort=nextRunAt:asc&limit=3 → { items, total }`, but that was
 * written before the Schedules front shipped and the endpoint it describes was
 * never built. The real contract (schedules spec §4.1) is narrower and is the
 * authority here:
 *   - filters are `sourceType` / `entityKind` / `enabledOnly` only, policed by
 *     `forbidNonWhitelisted` — the three sketched params were rejected with a
 *     400, not ignored;
 *   - the aggregation is deliberately un-paginated and returns a bare
 *     `ScheduleView[]`, already sorted by `nextRunAt` ascending (nulls last).
 * So `status=active` becomes the server-side `enabledOnly`, and the ordering
 * and limiting happen here.
 */
export async function getSoonRuns(): Promise<{ items: SoonRunItem[]; total: number }> {
    let schedules: ScheduleEntry[];
    try {
        const rows = await schedulesAPI.getAll({ enabledOnly: true });
        schedules = Array.isArray(rows) ? rows : [];
    } catch (error) {
        // `serverFetch` logs the failing response body but not the endpoint, so
        // before this line a 400 here was unattributable in the pod logs — and
        // the Soon block renders nothing when empty, so nothing on the page
        // gave the failure away either. Name the call.
        console.error('[dashboard] Soon block: GET /api/schedules failed', error);
        return { items: [], total: 0 };
    }

    const upcoming: SoonRunItem[] = [];
    for (const schedule of schedules) {
        const sourceKind = SOON_SOURCE_KINDS[schedule.sourceType];
        // `nextRunAt` is nullable on the wire (not every source can derive one)
        // while `SoonRunItem.nextRunAt` is not — a row with no computable next
        // run is not an upcoming run.
        if (!sourceKind || !schedule.nextRunAt) continue;
        upcoming.push({
            id: schedule.id,
            sourceKind,
            title: schedule.ownerName,
            nextRunAt: schedule.nextRunAt,
            href: schedule.ownerLink,
        });
    }

    // The API already sorts by `nextRunAt` ascending. Sorting again makes
    // "the soonest N" a property of this function instead of an unstated
    // dependency on the server's ordering. ISO-8601 UTC strings sort
    // lexicographically, which is how the API compares them too.
    upcoming.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));

    return { items: upcoming.slice(0, SOON_MAX), total: upcoming.length };
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
    let items: AttentionItem[] = [];

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
    items = items.slice(0, ATTENTION_MAX);

    return items;
}
