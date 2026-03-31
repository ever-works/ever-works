'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import type { ActivityLogEntry } from '@/lib/api/activity-log';
import { ActivityStatusBadge } from './ActivityStatusBadge';
import { ActivityTypeBadge } from './ActivityTypeBadge';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

interface ActivityTableProps {
	activities: ActivityLogEntry[];
	loading: boolean;
}

export function ActivityTable({ activities, loading }: ActivityTableProps) {
	const t = useTranslations('dashboard.activity');
	const [expandedIds, setExpandedIds] = useState<string[]>([]);

	const toggleExpanded = (id: string) => {
		setExpandedIds((current) =>
			current.includes(id) ? current.filter((i) => i !== id) : [...current, id],
		);
	};

	return (
		<div className={`overflow-hidden rounded-lg border border-border dark:border-border-dark ${loading ? 'opacity-60' : ''}`}>
			<table className="min-w-full divide-y divide-border dark:divide-border-dark">
				<thead className="bg-muted/50 dark:bg-muted/20">
					<tr>
						<th className="w-8 px-3 py-3" />
						<th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
							{t('columns.status')}
						</th>
						<th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
							{t('columns.dateTime')}
						</th>
						<th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
							{t('columns.directory')}
						</th>
						<th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
							{t('columns.type')}
						</th>
						<th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">
							{t('columns.summary')}
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border dark:divide-border-dark">
					{activities.map((activity) => {
						const isExpanded = expandedIds.includes(activity.id);
						const hasDetails = activity.details && Object.keys(activity.details).length > 0;

						return (
							<>
								<tr
									key={activity.id}
									className="bg-card dark:bg-transparent hover:bg-muted/30 dark:hover:bg-muted/10 cursor-pointer transition-colors"
									onClick={() => hasDetails && toggleExpanded(activity.id)}
								>
									<td className="px-3 py-3 text-center">
										{hasDetails && (
											isExpanded
												? <ChevronDown className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
												: <ChevronRight className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
										)}
									</td>
									<td className="px-4 py-3">
										<ActivityStatusBadge status={activity.status} />
									</td>
									<td className="px-4 py-3 text-sm text-text-muted dark:text-text-muted-dark whitespace-nowrap">
										<span title={new Date(activity.createdAt).toLocaleString()}>
											{formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}
										</span>
									</td>
									<td className="px-4 py-3 text-sm">
										{activity.directory ? (
											<Link
												href={ROUTES.DASHBOARD_DIRECTORY(activity.directoryId!)}
												className="text-primary hover:underline"
												onClick={(e) => e.stopPropagation()}
											>
												{activity.directory.name}
											</Link>
										) : (
											<span className="text-text-muted dark:text-text-muted-dark">—</span>
										)}
									</td>
									<td className="px-4 py-3">
										<ActivityTypeBadge actionType={activity.actionType} />
									</td>
									<td className="px-4 py-3 text-sm text-text dark:text-text-dark max-w-md truncate">
										{activity.summary}
									</td>
								</tr>
								{hasDetails && isExpanded && (
									<tr key={`${activity.id}-details`} className="bg-muted/20 dark:bg-muted/10">
										<td colSpan={6} className="px-6 py-4">
											<div className="space-y-3">
												<h4 className="text-sm font-medium text-text dark:text-text-dark">
													{t('detail.title')}
												</h4>
												<pre className="text-xs bg-surface-secondary dark:bg-surface-secondary-dark p-3 rounded-md overflow-x-auto text-text-muted dark:text-text-muted-dark">
													{JSON.stringify(activity.details, null, 2)}
												</pre>
											</div>
										</td>
									</tr>
								)}
							</>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
