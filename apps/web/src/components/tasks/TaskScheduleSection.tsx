'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarClock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { Task } from '@/lib/api/tasks';
import { scheduleTaskAction, unscheduleTaskAction } from '@/app/actions/tasks';
import { TaskRecurringSection } from './TaskRecurringSection';

/**
 * Tasks upgrades — the Task-detail Schedule section.
 *
 * One control for the three schedule modes a Task can be in:
 *
 *   - **Run once** — no schedule at all; the Task runs when a human (or
 *     an agent) dispatches it. This is the default and the state a Task
 *     returns to when a schedule is removed.
 *   - **Scheduled** — one-shot: `tasks.scheduledAt` holds a future
 *     instant, the cron dispatcher CAS-claims it and dispatches THIS
 *     Task (no clone).
 *   - **Recurring** — the pre-existing RRULE/cron template mode, still
 *     owned by {@link TaskRecurringSection}: the dispatcher spawns a
 *     fresh instance per occurrence.
 *
 * The modes are mutually exclusive server-side (`scheduleTask` refuses a
 * recurring template), so the radio mirrors that rather than pretending
 * both can be armed at once.
 */

type ScheduleMode = 'once' | 'scheduled' | 'recurring';

/** `<input type="datetime-local">` wants `YYYY-MM-DDTHH:mm` in LOCAL time. */
function toLocalInputValue(iso: string | null | undefined): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
        date.getHours(),
    )}:${pad(date.getMinutes())}`;
}

export function TaskScheduleSection({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.schedule');
    const initialMode: ScheduleMode = task.isRecurring
        ? 'recurring'
        : task.scheduledAt
          ? 'scheduled'
          : 'once';
    const [mode, setMode] = useState<ScheduleMode>(initialMode);

    const MODE_LABEL: Record<ScheduleMode, string> = {
        once: t('modeOnce'),
        scheduled: t('modeScheduled'),
        recurring: t('modeRecurring'),
    };

    return (
        <div className="space-y-3" data-testid="task-schedule-section">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <CalendarClock className="w-4 h-4 text-text-muted" />
                    {t('section')}
                </h2>
                <div
                    role="radiogroup"
                    aria-label={t('section')}
                    className="flex flex-wrap items-center gap-1.5"
                >
                    {(Object.keys(MODE_LABEL) as ScheduleMode[]).map((value) => (
                        <button
                            key={value}
                            type="button"
                            role="radio"
                            aria-checked={mode === value}
                            onClick={() => setMode(value)}
                            data-testid={`task-schedule-mode-${value}`}
                            className={cn(
                                'px-2.5 py-1.5 text-xs font-medium rounded border transition-colors',
                                mode === value
                                    ? 'border-primary bg-primary/10 text-primary'
                                    : 'border-border/60 dark:border-border-dark/60 text-text-secondary hover:text-text dark:hover:text-text-dark',
                            )}
                        >
                            {MODE_LABEL[value]}
                        </button>
                    ))}
                </div>

                {mode === 'once' && <RunOncePanel task={task} />}
                {mode === 'scheduled' && <ScheduledPanel task={task} />}
                {mode === 'recurring' && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('recurringHint')}
                    </p>
                )}
            </section>

            {/* The recurring cadence keeps its own panel — the mode radio
                only decides whether it is on screen. */}
            {mode === 'recurring' && <TaskRecurringSection task={task} />}
        </div>
    );
}

function RunOncePanel({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.schedule');
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleClear = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await unscheduleTaskAction(task.id);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('unscheduleError'));
                }
            })();
        });
    };

    return (
        <div className="space-y-2">
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('onceHint')}</p>
            {/* A Task still carrying a one-shot slot is not "run once"
                yet — offer the removal that actually makes it so. */}
            {task.scheduledAt && !task.isRecurring && (
                <div className="space-y-1">
                    <p className="text-[11px] text-warning">
                        {t('stillScheduled', {
                            at: new Date(task.scheduledAt).toLocaleString(),
                        })}
                    </p>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger gap-1.5"
                        onClick={handleClear}
                        disabled={pending}
                        data-testid="task-schedule-clear"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        {pending ? '…' : t('unschedule')}
                    </Button>
                </div>
            )}
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

function ScheduledPanel({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.schedule');
    const router = useRouter();
    const [runAt, setRunAt] = useState(toLocalInputValue(task.scheduledAt));
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    if (task.isRecurring) {
        return (
            <p className="text-xs text-warning" data-testid="task-schedule-recurring-conflict">
                {t('recurringConflict')}
            </p>
        );
    }

    const handleSave = () => {
        const parsed = runAt ? new Date(runAt) : null;
        if (!parsed || Number.isNaN(parsed.getTime())) {
            setError(t('errorInvalidDate'));
            return;
        }
        if (parsed.getTime() <= Date.now()) {
            setError(t('errorPastDate'));
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await scheduleTaskAction(task.id, parsed.toISOString());
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('scheduleError'));
                }
            })();
        });
    };

    const handleClear = () => {
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await unscheduleTaskAction(task.id);
                    setRunAt('');
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('unscheduleError'));
                }
            })();
        });
    };

    return (
        <div className="space-y-2">
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('scheduledHint')}
            </p>
            <label className="block text-[10px] text-text-muted" htmlFor="task-schedule-run-at">
                {t('runAt')}
            </label>
            <input
                id="task-schedule-run-at"
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                disabled={pending}
                data-testid="task-schedule-run-at"
                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
            />
            {task.scheduledAt && (
                <p className="text-[11px] text-text-secondary dark:text-text-secondary-dark">
                    {task.scheduleClaimedAt
                        ? t('firedAt', { at: new Date(task.scheduleClaimedAt).toLocaleString() })
                        : t('armedFor', { at: new Date(task.scheduledAt).toLocaleString() })}
                </p>
            )}
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={pending || !runAt}
                    data-testid="task-schedule-save"
                >
                    {pending ? '…' : t('save')}
                </Button>
                {task.scheduledAt && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        onClick={handleClear}
                        disabled={pending}
                        data-testid="task-schedule-clear"
                    >
                        {t('unschedule')}
                    </Button>
                )}
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
