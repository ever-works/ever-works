'use client';

import { useEffect, useState, useTransition } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { WorkProposal } from '@/lib/api/work-proposals';
import {
	getProposalsStatusAction,
	listProposalsAction,
	refreshProposalsAction
} from '@/app/actions/dashboard/work-proposals';
import { WorkProposalCard } from './WorkProposalCard';

const POLL_INTERVAL_MS = 6_000;
const POLL_MAX_MS = 120_000;

interface WorkProposalsSectionProps {
	initialProposals: WorkProposal[];
	initiallyResearching: boolean;
	username?: string;
}

export function WorkProposalsSection({
	initialProposals,
	initiallyResearching,
	username
}: WorkProposalsSectionProps) {
	const t = useTranslations('dashboard.proposals');
	const [proposals, setProposals] = useState(initialProposals);
	const [researching, setResearching] = useState(initiallyResearching);
	const [pendingRefresh, startRefreshTransition] = useTransition();
	const [refreshError, setRefreshError] = useState<string | null>(null);

	useEffect(() => {
		if (!researching) return;
		let cancelled = false;
		const deadline = Date.now() + POLL_MAX_MS;

		const loop = async () => {
			while (!cancelled && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
				if (cancelled) return;
				try {
					const [status, list] = await Promise.all([
						getProposalsStatusAction(),
						listProposalsAction()
					]);
					if (cancelled) return;
					setProposals(list);
					setResearching(status.researching);
					if (!status.researching) return;
				} catch {
					// Network blip — keep polling until deadline.
				}
			}
		};
		loop();
		return () => {
			cancelled = true;
		};
	}, [researching]);

	const handleRefresh = () => {
		setRefreshError(null);
		startRefreshTransition(async () => {
			try {
				const result = await refreshProposalsAction();
				if (result.status === 'queued') {
					setResearching(true);
				} else if (result.status === 'rate-limited') {
					setRefreshError(t('errors.rateLimited'));
				}
			} catch {
				setRefreshError(t('errors.generic'));
			}
		});
	};

	const handleDismissed = (id: string) => {
		setProposals((prev) => prev.filter((p) => p.id !== id));
	};

	const showEmpty = proposals.length === 0 && !researching;
	const showResearching = researching && proposals.length === 0;

	return (
		<section className="mt-8" aria-labelledby="work-proposals-heading">
			<div className="flex items-center justify-between mb-4">
				<div className="flex items-center gap-2">
					<Sparkles className="w-5 h-5 text-primary" />
					<h2
						id="work-proposals-heading"
						className="text-xl font-semibold text-text dark:text-text-dark"
					>
						{username ? t('header.titleWithName', { username }) : t('header.title')}
					</h2>
				</div>
				<button
					type="button"
					onClick={handleRefresh}
					disabled={pendingRefresh || researching}
					className="inline-flex items-center gap-1.5 text-sm text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors disabled:opacity-50"
				>
					{pendingRefresh || researching ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<RefreshCw className="w-4 h-4" />
					)}
					{t('actions.refresh')}
				</button>
			</div>

			{refreshError && (
				<p className="mb-3 text-sm text-red-500 dark:text-red-400">{refreshError}</p>
			)}

			{showResearching && (
				<div className="rounded-md p-5 bg-card dark:bg-surface-secondary-dark border border-card-border text-sm text-text-secondary dark:text-text-secondary-dark">
					<div className="flex items-center gap-2">
						<Loader2 className="w-4 h-4 animate-spin" />
						<span>{t('researching.title')}</span>
					</div>
					<p className="mt-1 text-xs">{t('researching.subtitle')}</p>
				</div>
			)}

			{!showResearching && showEmpty && (
				<div className="rounded-md p-5 bg-card dark:bg-surface-secondary-dark border border-card-border text-sm text-text-secondary dark:text-text-secondary-dark">
					<p>{t('empty.title')}</p>
					<p className="mt-1 text-xs">{t('empty.subtitle')}</p>
				</div>
			)}

			{proposals.length > 0 && (
				<div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
					{proposals.map((p) => (
						<WorkProposalCard key={p.id} proposal={p} onDismissed={handleDismissed} />
					))}
				</div>
			)}

			<p className="mt-3 text-xs text-text-secondary dark:text-text-secondary-dark">
				{t('disclosure')}
			</p>
		</section>
	);
}
