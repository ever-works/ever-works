'use client';

import { useEffect, useState } from 'react';
import { Gauge, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { PageHeader } from '@/components/common/PageHeader';
import { GoalCard } from './GoalCard';
import type { Goal, GoalStatus } from '@/lib/api/goals';

const GOAL_STATUSES: GoalStatus[] = ['draft', 'active', 'paused', 'completed'];

interface GoalsListProps {
    goals: Goal[];
    loadError?: string | null;
    filters?: {
        status?: GoalStatus;
    };
    pagination?: {
        offset: number;
        hasPrevious: boolean;
        hasNext: boolean;
        previousHref: string;
        nextHref: string;
    };
}

/**
 * Goals & Metrics — PR-8. `/goals` catalog list client. Grid of
 * GoalCards with a status filter and a "+ New Goal" CTA routing to
 * the dedicated create form. Load failures are surfaced explicitly so
 * a flaky API doesn't masquerade as an empty Goal catalog.
 */
export function GoalsList({ goals, loadError = null, filters, pagination }: GoalsListProps) {
    const t = useTranslations('dashboard.goalsPage');
    const [statusFilter, setStatusFilter] = useState(filters?.status ?? '');
    useEffect(() => {
        setStatusFilter(filters?.status ?? '');
    }, [filters?.status]);

    return (
        <div className="w-full">
            <PageHeader
                icon={Gauge}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="info"
                actions={
                    <Button href="/goals/new" size="sm">
                        <Plus className="w-4 h-4" />
                        <span className="font-medium">{t('newGoal')}</span>
                    </Button>
                }
            />

            <form className="mb-5 mt-8 flex flex-col gap-2 @lg/main:flex-row @lg/main:items-end">
                <div className="min-w-40">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('filterBar.status')}
                    </span>
                    <input type="hidden" name="status" value={statusFilter} />
                    <Select
                        value={statusFilter}
                        onValueChange={setStatusFilter}
                        placeholder={t('filterBar.anyStatus')}
                        size="xs"
                    >
                        <option value="">{t('filterBar.anyStatus')}</option>
                        {GOAL_STATUSES.map((status) => (
                            <option key={status} value={status}>
                                {t(`statuses.${status}`)}
                            </option>
                        ))}
                    </Select>
                </div>
                <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                        {t('filterBar.apply')}
                    </Button>
                    <Button href="/goals" size="sm" variant="ghost">
                        {t('filterBar.reset')}
                    </Button>
                </div>
            </form>

            {loadError ? (
                <div
                    role="alert"
                    className="mb-5 rounded-lg border border-danger/30 bg-danger/5 p-4"
                >
                    <p className="text-sm font-medium text-danger">{t('loadError.title')}</p>
                    <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                        {loadError}
                    </p>
                </div>
            ) : null}

            {!loadError ? (
                goals.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 bg-surface/40 dark:bg-surface-dark/30 p-8 text-center">
                        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-info/20 bg-info/10">
                            <Gauge className="w-4 h-4 text-info" />
                        </div>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('empty.title')}
                        </p>
                        <p className="mx-auto mt-1 max-w-2xl text-xs text-text-muted dark:text-text-muted-dark">
                            {t('empty.subtitle')}
                        </p>
                        <div className="mt-4">
                            <Button href="/goals/new" size="sm">
                                <Plus className="w-4 h-4" />
                                <span className="font-medium">{t('newGoal')}</span>
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                        {goals.map((g) => (
                            <GoalCard key={g.id} goal={g} />
                        ))}
                    </div>
                )
            ) : null}

            {!loadError && pagination && (pagination.hasPrevious || pagination.hasNext) ? (
                <nav className="mt-5 flex items-center justify-between gap-3 text-xs text-text-muted dark:text-text-muted-dark">
                    {goals.length > 0 ? (
                        <span>
                            {t('pagination.showing', {
                                from: pagination.offset + 1,
                                to: pagination.offset + goals.length,
                            })}
                        </span>
                    ) : (
                        <span>{t('pagination.noResults')}</span>
                    )}
                    <div className="flex items-center gap-2">
                        {pagination.hasPrevious ? (
                            <Link
                                href={pagination.previousHref}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                {t('pagination.previous')}
                            </Link>
                        ) : null}
                        {pagination.hasNext ? (
                            <Link
                                href={pagination.nextHref}
                                className="rounded-md border border-border/60 dark:border-border-dark/60 px-3 py-1.5 text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                            >
                                {t('pagination.next')}
                            </Link>
                        ) : null}
                    </div>
                </nav>
            ) : null}
        </div>
    );
}
