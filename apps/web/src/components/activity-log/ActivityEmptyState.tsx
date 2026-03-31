'use client';

import { useTranslations } from 'next-intl';
import { Activity } from 'lucide-react';

export function ActivityEmptyState() {
	const t = useTranslations('dashboard.activity');

	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary dark:bg-surface-secondary-dark">
				<Activity className="h-7 w-7 text-text-muted dark:text-text-muted-dark" />
			</div>
			<h3 className="text-lg font-semibold text-text dark:text-text-dark mb-1">
				{t('empty.title')}
			</h3>
			<p className="text-sm text-text-muted dark:text-text-muted-dark max-w-sm">
				{t('empty.description')}
			</p>
		</div>
	);
}
