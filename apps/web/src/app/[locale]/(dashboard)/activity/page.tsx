import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getActivityLog } from '@/app/actions/activity-log';
import { ActivityClient } from './activity-client';

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations('metadata.pages');
	return { title: t('activity') };
}

export default async function ActivityPage() {
	const response = await getActivityLog({ limit: 25 }).catch(() => ({
		success: false,
		activities: [],
		total: 0,
	}));

	return (
		<ActivityClient
			initialActivities={response.activities}
			totalActivities={response.total}
		/>
	);
}
