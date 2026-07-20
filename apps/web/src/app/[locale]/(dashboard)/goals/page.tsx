import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { goalsAPI, type Goal, type GoalStatus } from '@/lib/api/goals';
import { GoalsList } from '@/components/goals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.goalsPage');
    return { title: t('title') };
}

const GOAL_STATUSES: GoalStatus[] = ['draft', 'active', 'paused', 'completed'];
const PAGE_SIZE = 24;

type GoalsSearchParams = Promise<{
    status?: string | string[];
    offset?: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function buildGoalsHref(input: { status?: GoalStatus; offset?: number }): string {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `/goals?${qs}` : '/goals';
}

/**
 * Goals & Metrics — PR-8. `/goals` catalog page. Server-fetches the
 * user's Goal list with bounded pagination and hands load errors to
 * the client so a flaky API doesn't masquerade as an empty catalog.
 */
export default async function GoalsPage({ searchParams }: { searchParams: GoalsSearchParams }) {
    const params = await searchParams;
    const statusParam = firstParam(params.status);
    const status = GOAL_STATUSES.includes(statusParam as GoalStatus)
        ? (statusParam as GoalStatus)
        : undefined;
    const offset = Math.max(0, parseInt(firstParam(params.offset) ?? '0', 10) || 0);

    let goals: Goal[] = [];
    let loadError: string | null = null;
    try {
        goals = await goalsAPI.list({ status, offset, limit: PAGE_SIZE + 1 });
    } catch (err) {
        loadError = err instanceof Error ? err.message : 'Failed to load Goals.';
    }

    const hasNext = goals.length > PAGE_SIZE;
    const pageGoals = hasNext ? goals.slice(0, PAGE_SIZE) : goals;
    const prevOffset = Math.max(0, offset - PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;

    return (
        <GoalsList
            goals={pageGoals}
            loadError={loadError}
            filters={{ status }}
            pagination={{
                offset,
                hasPrevious: offset > 0,
                hasNext,
                previousHref: buildGoalsHref({ status, offset: prevOffset }),
                nextHref: buildGoalsHref({ status, offset: nextOffset }),
            }}
        />
    );
}
