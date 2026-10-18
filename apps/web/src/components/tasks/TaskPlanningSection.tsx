'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarRange } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { Task } from '@/lib/api/tasks';
import { updateTaskPlanningAction } from '@/app/actions/tasks';

/** `<input type="date">` wants `YYYY-MM-DD` in LOCAL time. */
function toDateInput(iso: string | null | undefined): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * EW-P2-3 — the Task-detail Planning section: due date, start date and the
 * estimate. Planning only (nothing runs at these times — that is the Schedule
 * section). The due date is the end of the picked local day, the start date
 * its beginning; clearing a field sends `null`.
 */
export function TaskPlanningSection({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.planning');
    const router = useRouter();
    const [due, setDue] = useState(toDateInput(task.dueAt));
    const [start, setStart] = useState(toDateInput(task.startAt));
    const [estimate, setEstimate] = useState(
        task.estimateMinutes === null || task.estimateMinutes === undefined
            ? ''
            : String(task.estimateMinutes),
    );
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleSave = () => {
        const dueAt = due ? new Date(`${due}T23:59:59`) : null;
        const startAt = start ? new Date(`${start}T00:00:00`) : null;
        if (dueAt && startAt && startAt.getTime() > dueAt.getTime()) {
            setError(t('errorStartAfterDue'));
            return;
        }
        let estimateMinutes: number | null = null;
        if (estimate.trim() !== '') {
            const n = Number(estimate);
            if (!Number.isInteger(n) || n < 0 || n > 525600) {
                setError(t('errorEstimate'));
                return;
            }
            estimateMinutes = n;
        }
        // Send only what the user changed: a date another system set with a
        // time of day (e.g. a Gauzy due date at 10:00) must not be rewritten to
        // the end of the local day — and re-arm its due-soon notice — just
        // because the estimate was edited.
        const patch: {
            dueAt?: string | null;
            startAt?: string | null;
            estimateMinutes?: number | null;
        } = {};
        if (due !== toDateInput(task.dueAt)) patch.dueAt = dueAt ? dueAt.toISOString() : null;
        if (start !== toDateInput(task.startAt)) {
            patch.startAt = startAt ? startAt.toISOString() : null;
        }
        if (estimateMinutes !== (task.estimateMinutes ?? null))
            patch.estimateMinutes = estimateMinutes;
        setError(null);
        if (Object.keys(patch).length === 0) return;
        // An async transition: `pending` covers the request itself, so the
        // inputs and Save stay disabled until it settles (no overlapping saves).
        startTransition(async () => {
            // Review 2026-10-17 U9: the refusal comes back as a value, so its reason shows
            // (a thrown one is replaced by a generic text in production).
            try {
                const result = await updateTaskPlanningAction(task.id, patch);
                if (!result.ok) {
                    setError(result.message || t('saveError'));
                    return;
                }
                toast.success(t('saved'));
                router.refresh();
            } catch {
                setError(t('saveError'));
            }
        });
    };

    const inputClass =
        'w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs';

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3"
            data-testid="task-planning-section"
        >
            <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                <CalendarRange className="w-4 h-4 text-text-muted" />
                {t('section')}
            </h2>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('hint')}</p>
            <div className="grid grid-cols-3 gap-3">
                <div>
                    <label
                        className="block text-[10px] text-text-muted"
                        htmlFor="task-planning-due"
                    >
                        {t('dueAt')}
                    </label>
                    <input
                        id="task-planning-due"
                        type="date"
                        value={due}
                        onChange={(e) => setDue(e.target.value)}
                        disabled={pending}
                        data-testid="task-planning-due"
                        className={inputClass}
                    />
                </div>
                <div>
                    <label
                        className="block text-[10px] text-text-muted"
                        htmlFor="task-planning-start"
                    >
                        {t('startAt')}
                    </label>
                    <input
                        id="task-planning-start"
                        type="date"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                        disabled={pending}
                        data-testid="task-planning-start"
                        className={inputClass}
                    />
                </div>
                <div>
                    <label
                        className="block text-[10px] text-text-muted"
                        htmlFor="task-planning-estimate"
                    >
                        {t('estimateMinutes')}
                    </label>
                    <input
                        id="task-planning-estimate"
                        type="number"
                        min={0}
                        max={525600}
                        step={1}
                        inputMode="numeric"
                        value={estimate}
                        onChange={(e) => setEstimate(e.target.value)}
                        disabled={pending}
                        data-testid="task-planning-estimate"
                        className={inputClass}
                    />
                </div>
            </div>
            <Button
                size="sm"
                onClick={handleSave}
                disabled={pending}
                data-testid="task-planning-save"
            >
                {pending ? '…' : t('save')}
            </Button>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
