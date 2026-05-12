'use client';

import { useTranslations } from 'next-intl';
import { Compass } from 'lucide-react';
import { WorkProposalsSection } from '@/components/dashboard/WorkProposalsSection';
import type { WorkProposal } from '@/lib/api/work-proposals';

interface DiscoverClientProps {
	initialProposals: WorkProposal[];
	initiallyResearching: boolean;
}

export function DiscoverClient({ initialProposals, initiallyResearching }: DiscoverClientProps) {
	const t = useTranslations('dashboard.discover');

	return (
		<div className="w-full">
			<div className="mb-8 flex items-center gap-3">
				<Compass className="w-7 h-7 text-primary" />
				<div>
					<h1 className="text-3xl font-bold text-text dark:text-text-dark">{t('title')}</h1>
					<p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
						{t('subtitle')}
					</p>
				</div>
			</div>

			<WorkProposalsSection
				initialProposals={initialProposals}
				initiallyResearching={initiallyResearching}
			/>
		</div>
	);
}
