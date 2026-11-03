'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import {
    TASK_DELIVERY_FILTER_OPTIONS,
    TASK_DELIVERY_FILTER_PARAM,
    parseTaskDeliveryFilter,
} from '@/lib/task-delivery-filter';

const TASK_STATUSES = [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
] as const;

const TASK_PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;

interface TasksFilterSelectsProps {
    defaultStatus?: string;
    defaultPriority?: string;
    /**
     * APW-08 T27 — show the **Delivery** select. Only an App Work's Tasks have a delivery
     * chain, so only that scope passes it; everywhere else the form is unchanged.
     */
    showDelivery?: boolean;
    defaultDelivery?: string;
    /** Hide the status and priority selects (a scope that filters by Delivery only). */
    deliveryOnly?: boolean;
}

export function TasksFilterSelects({
    defaultStatus = '',
    defaultPriority = '',
    showDelivery = false,
    defaultDelivery = '',
    deliveryOnly = false,
}: TasksFilterSelectsProps) {
    const t = useTranslations('dashboard.tasksPage');
    let [status, setStatus] = useState(defaultStatus);
    let [priority, setPriority] = useState(defaultPriority);
    const [delivery, setDelivery] = useState(parseTaskDeliveryFilter(defaultDelivery) ?? '');

    return (
        <>
            {/* Hidden inputs carry values through native form submission */}
            {!deliveryOnly && <input type="hidden" name="status" value={status} />}
            {!deliveryOnly && <input type="hidden" name="priority" value={priority} />}
            {showDelivery && (
                <input type="hidden" name={TASK_DELIVERY_FILTER_PARAM} value={delivery} />
            )}

            {!deliveryOnly && (
                <div className="min-w-40">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('list.filter.status')}
                    </span>
                    <Select
                        value={status}
                        onValueChange={setStatus}
                        placeholder={t('list.filter.anyStatus')}
                        size="xs"
                    >
                        <option value="">{t('list.filter.anyStatus')}</option>
                        {TASK_STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {t(`status.${s}`)}
                            </option>
                        ))}
                    </Select>
                </div>
            )}

            {!deliveryOnly && (
                <div className="min-w-36">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('list.filter.priority')}
                    </span>
                    <Select
                        value={priority}
                        onValueChange={setPriority}
                        placeholder={t('list.filter.anyPriority')}
                        size="xs"
                    >
                        <option value="">{t('list.filter.anyPriority')}</option>
                        {TASK_PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                                {p.toUpperCase()}
                            </option>
                        ))}
                    </Select>
                </div>
            )}

            {showDelivery && (
                <div className="min-w-44" data-testid="task-delivery-filter">
                    <span className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('delivery.filterLabel')}
                    </span>
                    <Select
                        value={delivery}
                        onValueChange={(value) => setDelivery(parseTaskDeliveryFilter(value) ?? '')}
                        placeholder={t('delivery.filterAny')}
                        size="xs"
                        data-testid="task-delivery-filter-select"
                        aria-label={t('delivery.filterLabel')}
                    >
                        <option value="">{t('delivery.filterAny')}</option>
                        {TASK_DELIVERY_FILTER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {t(`delivery.${option.labelKey}`)}
                            </option>
                        ))}
                    </Select>
                </div>
            )}
        </>
    );
}
