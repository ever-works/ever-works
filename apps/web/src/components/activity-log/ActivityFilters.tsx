'use client';

import { useTranslations } from 'next-intl';
import { Search, X } from 'lucide-react';
import { Select } from '../ui/select';

const ACTION_TYPES = [
    { value: '', label: 'allTypes' },
    { value: 'generation', label: 'generation' },
    { value: 'comparison_generation', label: 'comparison' },
    { value: 'deployment', label: 'deployment' },
    { value: 'work_created', label: 'workCreated' },
    { value: 'work_updated', label: 'workUpdated' },
    { value: 'work_deleted', label: 'workDeleted' },
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
    { value: 'cancelled', label: 'cancelled' },
];

interface ActivityFiltersProps {
    actionType: string;
    onActionTypeChange: (value: string) => void;
    status: string;
    onStatusChange: (value: string) => void;
    search: string;
    onSearchChange: (value: string) => void;
    loading?: boolean;
    hasActiveFilters: boolean;
    onClearFilters: () => void;
}

export function ActivityFilters({
    actionType,
    onActionTypeChange,
    status,
    onStatusChange,
    search,
    onSearchChange,
    loading = false,
    hasActiveFilters,
    onClearFilters,
}: ActivityFiltersProps) {
    const t = useTranslations('dashboard.activity');

    const selectClass = 'min-w-[220px]';

    return (
        <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[450px] w-3/4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder={t('filters.search')}
                    aria-label={t('filters.search')}
                    disabled={loading}
                    className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark text-text dark:text-text-dark placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
            </div>

            <Select
                value={actionType}
                onValueChange={onActionTypeChange}
                aria-label={t('columns.type')}
                className={selectClass}
                disabled={loading}
            >
                {ACTION_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                        {t(`filters.types.${type.label}` as any)}
                    </option>
                ))}
            </Select>

            <Select
                value={status}
                onValueChange={onStatusChange}
                aria-label={t('columns.status')}
                className={selectClass}
                disabled={loading}
            >
                {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                        {t(`filters.statuses.${opt.label}` as any)}
                    </option>
                ))}
            </Select>

            {hasActiveFilters && (
                <button
                    onClick={onClearFilters}
                    disabled={loading}
                    className="inline-flex cursor-pointer items-center border border-border dark:border-border-dark gap-1 px-3 py-2 text-sm rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                >
                    <X className="w-3.5 h-3.5" />
                    {t('actions.clearFilters')}
                </button>
            )}

            {loading && (
                <span className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('loading')}
                </span>
            )}
        </div>
    );
}
