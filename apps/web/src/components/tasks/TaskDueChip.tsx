'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { Task } from '@/lib/api/tasks';

/**
 * EW-P2-3 — a Task's due date on a board card. Red once the date has passed
 * while the Task is still open; a done or cancelled Task shows its date
 * plainly (it is no longer late for anything).
 */
export function TaskDueChip({ task }: { task: Pick<Task, 'dueAt' | 'status'> }) {
    const t = useTranslations('dashboard.tasksPage.planning');
    // The clock is read on mount and again the moment the deadline passes, never
    // in the render body (`react-hooks/purity`), so a card that becomes overdue
    // while the board is open turns red without a reload.
    const [now, setNow] = useState(() => Date.now());
    const dueMs = task.dueAt ? new Date(task.dueAt).getTime() : NaN;
    const closed = task.status === 'done' || task.status === 'cancelled';
    useEffect(() => {
        if (closed || Number.isNaN(dueMs)) return;
        const wait = dueMs - Date.now();
        // setTimeout caps at ~24.8 days; a later deadline is re-armed on remount.
        if (wait <= 0 || wait > 2_147_000_000) return;
        const timer = setTimeout(() => setNow(Date.now()), wait + 1_000);
        return () => clearTimeout(timer);
    }, [dueMs, closed]);
    if (!task.dueAt || Number.isNaN(dueMs)) return null;
    const due = new Date(dueMs);
    const overdue = !closed && dueMs < now;
    const date = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return (
        <span
            data-testid="task-due-chip"
            data-overdue={overdue ? 'true' : 'false'}
            title={due.toLocaleString()}
            className={cn(
                'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded',
                overdue
                    ? 'bg-danger/10 text-danger'
                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary',
            )}
        >
            <CalendarClock className="w-3 h-3" aria-hidden />
            {overdue ? t('overdue', { date }) : t('due', { date })}
        </span>
    );
}
