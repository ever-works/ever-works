'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Repeat, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Task } from '@/lib/api/tasks';
import { clearTaskRecurringAction, setTaskRecurringAction } from '@/app/actions/tasks';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 17.8 UI.
 *
 * Recurring-task toggle + frequency picker. Sits on the Task
 * detail page beside the transition controls. Two modes:
 *
 *   - Inactive (`task.isRecurring=false`): "Make recurring" CTA
 *     opens a frequency picker (Daily / Weekly / Monthly / Custom
 *     RRULE) + optional end date / max occurrences.
 *   - Active: shows the current RRULE + nextOccurrenceAt + occurrence
 *     counter, with a "Stop recurring" button that demotes the
 *     template back to a plain Task.
 *
 * The picker emits an RRULE string per RFC 5545 (`FREQ=DAILY` /
 * `FREQ=WEEKLY` / `FREQ=MONTHLY` / custom). `TasksService.setRecurring`
 * validates the rule + computes the first `nextOccurrenceAt`; rules
 * with no future occurrences are rejected with a clear error.
 */

/* The right rail is one visual system: every section is the same neutral
 * card under the same uppercase muted heading. Kept as constants so this
 * section cannot drift away from `TaskBranchSection` and the Details card
 * next to it. */
const SECTION_CLASS =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-3';
const HEADING_CLASS =
    'text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2';

type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';

export function TaskRecurringSection({ task }: { task: Task }) {
    if (task.isRecurring) {
        return <ActivePanel task={task} />;
    }
    return <InactivePanel task={task} />;
}

/** Rail row: fixed label column, value on the right — mirrors `DetailRow`. */
function RecurrenceRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
            <dt className="text-xs text-text-muted pt-0.5">{label}</dt>
            <dd className="min-w-0">{children}</dd>
        </div>
    );
}

function ActivePanel({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.recurring');
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleStop = () => {
        if (!confirm(t('stopConfirm'))) {
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await clearTaskRecurringAction(task.id);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('stopError'));
                }
            })();
        });
    };

    return (
        <section className={SECTION_CLASS} data-testid="task-recurring-section">
            <h2 className={HEADING_CLASS}>
                <Repeat className="w-3.5 h-3.5" />
                {t('section')}
            </h2>
            <dl className="space-y-3">
                <RecurrenceRow label={t('rule')}>
                    <span className="text-xs font-mono break-all text-text dark:text-text-dark">
                        {task.recurrenceRule ?? '—'}
                    </span>
                </RecurrenceRow>
                {task.recurrenceTimezone && (
                    <RecurrenceRow label={t('timezone')}>
                        <span className="text-xs font-mono text-text-secondary dark:text-text-secondary-dark">
                            {task.recurrenceTimezone}
                        </span>
                    </RecurrenceRow>
                )}
                {task.nextOccurrenceAt && (
                    <RecurrenceRow label={t('nextAt')}>
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {new Date(task.nextOccurrenceAt).toLocaleString()}
                        </span>
                    </RecurrenceRow>
                )}
                {task.recurrenceEndsAt && (
                    <RecurrenceRow label={t('ends')}>
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {new Date(task.recurrenceEndsAt).toLocaleDateString()}
                        </span>
                    </RecurrenceRow>
                )}
                {task.recurrenceMaxOccurrences != null && (
                    <RecurrenceRow label={t('max')}>
                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {task.recurrenceOccurredCount ?? 0} / {task.recurrenceMaxOccurrences}
                        </span>
                    </RecurrenceRow>
                )}
            </dl>
            <div className="pt-2 border-t border-border/40 dark:border-border-dark/40">
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleStop}
                    disabled={pending}
                    className="text-danger gap-1.5"
                    data-testid="task-recurring-demote"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                    {pending ? '…' : t('demote')}
                </Button>
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}

const DAYS_OF_WEEK = [
    { value: 'MO', label: 'Mon' },
    { value: 'TU', label: 'Tue' },
    { value: 'WE', label: 'Wed' },
    { value: 'TH', label: 'Thu' },
    { value: 'FR', label: 'Fri' },
    { value: 'SA', label: 'Sat' },
    { value: 'SU', label: 'Sun' },
] as const;

type DayOfWeek = (typeof DAYS_OF_WEEK)[number]['value'];

function detectBrowserTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

function InactivePanel({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.recurring');
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [frequency, setFrequency] = useState<Frequency>('WEEKLY');
    const [customRule, setCustomRule] = useState('FREQ=WEEKLY;BYDAY=MO');
    const [endsAt, setEndsAt] = useState('');
    const [maxOccurrences, setMaxOccurrences] = useState('');
    // FU-7 — friendly RRULE controls. Defaults match the original
    // single-frequency picker behaviour: 9:00, Monday-only for Weekly,
    // 1st-of-month for Monthly, browser timezone if available.
    const [timeOfDay, setTimeOfDay] = useState('09:00');
    const [daysOfWeek, setDaysOfWeek] = useState<DayOfWeek[]>(['MO']);
    const [dayOfMonth, setDayOfMonth] = useState('1');
    const [timezone, setTimezone] = useState<string>(() => detectBrowserTimezone());
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const ruleString = useMemo(() => {
        if (frequency === 'CUSTOM') return customRule.trim();
        const parts: string[] = [`FREQ=${frequency}`];
        // Parse HH:MM → BYHOUR + BYMINUTE. Skip when blank.
        const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay.trim());
        if (match) {
            const hour = Math.min(23, Math.max(0, parseInt(match[1], 10) || 0));
            const minute = Math.min(59, Math.max(0, parseInt(match[2], 10) || 0));
            parts.push(`BYHOUR=${hour}`, `BYMINUTE=${minute}`);
        }
        if (frequency === 'WEEKLY' && daysOfWeek.length > 0) {
            parts.push(`BYDAY=${daysOfWeek.join(',')}`);
        }
        if (frequency === 'MONTHLY' && dayOfMonth.trim().length > 0) {
            const d = Math.min(31, Math.max(1, parseInt(dayOfMonth, 10) || 1));
            parts.push(`BYMONTHDAY=${d}`);
        }
        return parts.join(';');
    }, [frequency, customRule, timeOfDay, daysOfWeek, dayOfMonth]);

    const isValidRule = useMemo(() => {
        // Lightweight client-side check — fully validated server-side
        // via the `rrule` package on `TasksService.setRecurring`.
        if (!ruleString) return false;
        if (!/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY|HOURLY|MINUTELY|SECONDLY)/.test(ruleString)) {
            return false;
        }
        if (frequency === 'WEEKLY' && daysOfWeek.length === 0) return false;
        return true;
    }, [ruleString, frequency, daysOfWeek]);

    const toggleDay = (day: DayOfWeek) => {
        setDaysOfWeek((prev) =>
            prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
        );
    };

    const handleSave = () => {
        if (!isValidRule) {
            setError(
                frequency === 'WEEKLY' && daysOfWeek.length === 0
                    ? 'Pick at least one weekday.'
                    : 'A valid recurrence rule is required.',
            );
            return;
        }
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await setTaskRecurringAction(task.id, {
                        recurrenceRule: ruleString,
                        recurrenceTimezone: timezone || undefined,
                        recurrenceEndsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
                        recurrenceMaxOccurrences:
                            maxOccurrences.trim().length > 0
                                ? Math.max(1, Math.min(9999, parseInt(maxOccurrences, 10) || 1))
                                : undefined,
                    });
                    setOpen(false);
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to save');
                }
            })();
        });
    };

    const FREQUENCY_LABEL: Record<Frequency, string> = {
        DAILY: t('daily'),
        WEEKLY: t('weekly'),
        MONTHLY: t('monthly'),
        CUSTOM: t('custom'),
    };

    if (!open) {
        return (
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-2">
                <h2 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                    <Repeat className="w-4 h-4 text-text-muted" />
                    {t('section')}
                </h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    This Task does not repeat. Promote it to a recurring template to spawn fresh
                    instances on a schedule.
                </p>
                <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                    {t('promoteToRecurring')}
                </Button>
            </section>
        );
    }

    return (
        <section className="rounded-xl border border-info/30 bg-info/5 p-5 space-y-3">
            <h2 className="text-sm font-medium text-info flex items-center gap-2">
                <Repeat className="w-4 h-4" />
                {t('promoteToRecurring')}
            </h2>
            <div className="grid grid-cols-1 @md/main:grid-cols-2 gap-3">
                <div>
                    <label className="block text-[10px] text-text-muted mb-1">Frequency</label>
                    <select
                        value={frequency}
                        onChange={(e) => setFrequency(e.target.value as Frequency)}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                    >
                        {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => (
                            <option key={f} value={f}>
                                {FREQUENCY_LABEL[f]}
                            </option>
                        ))}
                    </select>
                </div>
                {frequency === 'CUSTOM' && (
                    <div>
                        <label className="block text-[10px] text-text-muted mb-1">
                            {t('custom')}
                        </label>
                        <input
                            type="text"
                            value={customRule}
                            onChange={(e) => setCustomRule(e.target.value)}
                            placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs font-mono"
                        />
                    </div>
                )}
                {frequency !== 'CUSTOM' && (
                    <div>
                        <label className="block text-[10px] text-text-muted mb-1">
                            {t('timeOfDay')}
                        </label>
                        <input
                            type="time"
                            value={timeOfDay}
                            onChange={(e) => setTimeOfDay(e.target.value)}
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                        />
                    </div>
                )}
                {frequency === 'WEEKLY' && (
                    <div className="@md/main:col-span-2">
                        <label className="block text-[10px] text-text-muted mb-1">
                            {t('dayOfWeek')}
                        </label>
                        <div className="flex flex-wrap gap-1">
                            {DAYS_OF_WEEK.map((d) => {
                                const active = daysOfWeek.includes(d.value);
                                return (
                                    <button
                                        key={d.value}
                                        type="button"
                                        onClick={() => toggleDay(d.value)}
                                        className={`text-[11px] px-2 h-7 rounded border transition-colors ${
                                            active
                                                ? 'border-primary bg-primary/10 text-primary'
                                                : 'border-border/60 dark:border-border-dark/60 text-text-secondary hover:text-text'
                                        }`}
                                    >
                                        {d.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
                {frequency === 'MONTHLY' && (
                    <div>
                        <label className="block text-[10px] text-text-muted mb-1">
                            {t('dayOfMonth')}
                        </label>
                        <input
                            type="number"
                            value={dayOfMonth}
                            onChange={(e) => setDayOfMonth(e.target.value)}
                            min={1}
                            max={31}
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                        />
                    </div>
                )}
                {frequency !== 'CUSTOM' && (
                    <div>
                        <label className="block text-[10px] text-text-muted mb-1">
                            {t('timezone')}
                        </label>
                        <input
                            type="text"
                            value={timezone}
                            onChange={(e) => setTimezone(e.target.value)}
                            placeholder="UTC"
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs font-mono"
                            list="task-tz-suggestions"
                        />
                        <datalist id="task-tz-suggestions">
                            <option value="UTC" />
                            <option value="America/New_York" />
                            <option value="America/Los_Angeles" />
                            <option value="Europe/London" />
                            <option value="Europe/Berlin" />
                            <option value="Asia/Tokyo" />
                            <option value="Asia/Singapore" />
                            <option value="Australia/Sydney" />
                        </datalist>
                    </div>
                )}
                <div>
                    <label className="block text-[10px] text-text-muted mb-1">
                        Ends (optional)
                    </label>
                    <input
                        type="date"
                        value={endsAt}
                        onChange={(e) => setEndsAt(e.target.value)}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                    />
                </div>
                <div>
                    <label className="block text-[10px] text-text-muted mb-1">
                        Max occurrences (optional)
                    </label>
                    <input
                        type="number"
                        value={maxOccurrences}
                        onChange={(e) => setMaxOccurrences(e.target.value)}
                        min={1}
                        max={9999}
                        placeholder="∞"
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-2 h-8 text-xs"
                    />
                </div>
            </div>
            <div className="text-[11px] text-text-muted font-mono">
                Rule preview: {ruleString || '(empty)'}
                {!isValidRule && ruleString && <span className="text-danger ml-2">· invalid</span>}
            </div>
            <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleSave} disabled={pending || !isValidRule}>
                    {pending ? '…' : t('save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                    Cancel
                </Button>
            </div>
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
}
