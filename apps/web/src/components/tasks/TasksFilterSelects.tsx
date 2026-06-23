'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';

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
}

export function TasksFilterSelects({
    defaultStatus = '',
    defaultPriority = '',
}: TasksFilterSelectsProps) {
    const t = useTranslations('dashboard.tasksPage');
    let [status, setStatus] = useState(defaultStatus);
    let [priority, setPriority] = useState(defaultPriority);

    return (
        <>
            {/* Hidden inputs carry values through native form submission */}
            <input type="hidden" name="status" value={status} />
            <input type="hidden" name="priority" value={priority} />

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
        </>
    );
}
