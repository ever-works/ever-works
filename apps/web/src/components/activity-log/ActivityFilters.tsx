'use client';

import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';

const ACTION_TYPES = [
	{ value: '', label: 'allTypes' },
	{ value: 'generation', label: 'generation' },
	{ value: 'comparison_generation', label: 'comparison' },
	{ value: 'deployment', label: 'deployment' },
	{ value: 'directory_created', label: 'directoryCreated' },
	{ value: 'directory_updated', label: 'directoryUpdated' },
	{ value: 'directory_deleted', label: 'directoryDeleted' },
	{ value: 'plugin_enabled', label: 'pluginEnabled' },
	{ value: 'plugin_disabled', label: 'pluginDisabled' },
	{ value: 'plugin_configured', label: 'pluginConfigured' },
	{ value: 'member_invited', label: 'memberInvited' },
	{ value: 'schedule_executed', label: 'scheduleExecuted' },
	{ value: 'import', label: 'import' },
	{ value: 'user_login', label: 'login' },
	{ value: 'user_signup', label: 'signup' },
];

const STATUS_OPTIONS = [
	{ value: '', label: 'allStatuses' },
	{ value: 'pending', label: 'pending' },
	{ value: 'in_progress', label: 'inProgress' },
	{ value: 'completed', label: 'completed' },
	{ value: 'failed', label: 'failed' },
];

interface ActivityFiltersProps {
	actionType: string;
	onActionTypeChange: (value: string) => void;
	status: string;
	onStatusChange: (value: string) => void;
	search: string;
	onSearchChange: (value: string) => void;
}

export function ActivityFilters({
	actionType,
	onActionTypeChange,
	status,
	onStatusChange,
	search,
	onSearchChange,
}: ActivityFiltersProps) {
	const t = useTranslations('dashboard.activity');

	const selectClass =
		'px-3 py-2 text-sm rounded-lg border border-border dark:border-border-dark bg-card dark:bg-transparent text-text dark:text-text-dark focus:outline-none focus:ring-2 focus:ring-primary/20';

	return (
		<div className="flex flex-wrap gap-3">
			<div className="relative flex-1 min-w-[200px]">
				<Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark" />
				<input
					type="text"
					value={search}
					onChange={(e) => onSearchChange(e.target.value)}
					placeholder={t('filters.search')}
					className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border dark:border-border-dark bg-card dark:bg-transparent text-text dark:text-text-dark placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20"
				/>
			</div>

			<select
				value={actionType}
				onChange={(e) => onActionTypeChange(e.target.value)}
				className={selectClass}
			>
				{ACTION_TYPES.map((type) => (
					<option key={type.value} value={type.value}>
						{t(`filters.types.${type.label}` as any)}
					</option>
				))}
			</select>

			<select
				value={status}
				onChange={(e) => onStatusChange(e.target.value)}
				className={selectClass}
			>
				{STATUS_OPTIONS.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{t(`filters.statuses.${opt.label}` as any)}
					</option>
				))}
			</select>
		</div>
	);
}
