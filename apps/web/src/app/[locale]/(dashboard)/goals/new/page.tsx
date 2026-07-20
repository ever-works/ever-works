import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { GoalForm } from '@/components/goals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.goalNew');
    return { title: t('title') };
}

/**
 * Goals & Metrics — PR-8. `/goals/new` — dedicated Goal creation
 * form. New Goals land in `draft`; activation happens from the detail
 * page once the metric source is confirmed.
 */
export default function NewGoalPage() {
    return <GoalForm />;
}
