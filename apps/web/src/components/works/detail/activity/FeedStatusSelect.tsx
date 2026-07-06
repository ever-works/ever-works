'use client';

import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { FEED_STATUS_FILTERS, type FeedStatusFilter } from './feed-status';

interface FeedStatusSelectProps {
    value: FeedStatusFilter;
    onChange: (status: FeedStatusFilter) => void;
}

// Labels reuse the global activity-log status translations so both pages
// stay word-for-word identical in every locale.
const STATUS_I18N: Record<FeedStatusFilter, string> = {
    all: 'allStatuses',
    in_progress: 'inProgress',
    completed: 'completed',
    pending: 'pending',
    failed: 'failed',
    cancelled: 'cancelled',
};

// Dot colors mirror the status summary cards on /activity.
const STATUS_DOT: Partial<Record<FeedStatusFilter, string>> = {
    in_progress: 'bg-info',
    completed: 'bg-success',
    pending: 'bg-warning',
    failed: 'bg-danger',
    cancelled: 'bg-amber-500',
};

export function FeedStatusSelect({ value, onChange }: FeedStatusSelectProps) {
    const t = useTranslations('dashboard.activity');

    return (
        <Select
            value={value}
            onValueChange={(next) => onChange(next as FeedStatusFilter)}
            aria-label={t('columns.status')}
            size="xs"
            className="min-w-40"
        >
            {FEED_STATUS_FILTERS.map((status) => (
                <option key={status} value={status} data-dot={STATUS_DOT[status]}>
                    {t(`filters.statuses.${STATUS_I18N[status]}` as Parameters<typeof t>[0])}
                </option>
            ))}
        </Select>
    );
}
