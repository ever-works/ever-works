import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { goalsAPI, type GoalMetricSample } from '@/lib/api/goals';
import { GoalDetailClient } from '@/components/goals';

/**
 * Goals & Metrics — PR-8. `/goals/[id]` detail page. Server-fetches
 * the Goal + its observation samples. Unknown ids / fetch failures
 * trigger notFound() so the user sees the standard 404 surface
 * instead of a half-rendered page; the samples fetch is defensive
 * (`.catch(() => [])`) so a flaky samples endpoint just renders the
 * empty sparkline state.
 */
type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const goal = await goalsAPI.get(id);
    if (!goal) {
        const t = await getTranslations('dashboard.goalsPage');
        return { title: t('title') };
    }
    return { title: goal.title };
}

export default async function GoalDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const goal = await goalsAPI.get(id);
    if (!goal) {
        notFound();
    }

    const samples: GoalMetricSample[] = await goalsAPI.samples(id, 200).catch(() => []);

    return <GoalDetailClient goal={goal} samples={samples} />;
}
