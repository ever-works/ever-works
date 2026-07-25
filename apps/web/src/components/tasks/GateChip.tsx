'use client';

import { useTranslations } from 'next-intl';
import { Check, Minus, X } from 'lucide-react';
import type { GateStatus } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/**
 * Quality gates (Wave 3 M6) — compact gate-verdict chip.
 *
 * One glance answers "can this open a PR": green = every required
 * acceptance check passed, red = at least one required check did not,
 * skipped = checks resolved but were not run (a skipped gate must NEVER
 * render as green), none = no checks resolved for the run.
 *
 * Rendered on kanban cards next to the run chip, on Sessions rows, and
 * in the Task-detail Checks section. Parents decide *whether* to render
 * (e.g. only when the latest run carries a gateStatus); this component
 * renders any of the four verdicts.
 */

const TONES: Record<GateStatus, string> = {
    green: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    red: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    skipped: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
    none: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

const ICONS: Record<GateStatus, typeof Check> = {
    green: Check,
    red: X,
    skipped: Minus,
    none: Minus,
};

export function GateChip({
    status,
    failedCount,
    className,
}: {
    status: GateStatus;
    /** Red only — number of failed required checks, shown as "· N". */
    failedCount?: number;
    className?: string;
}) {
    const t = useTranslations('dashboard.tasksPage.gateChip');
    const tone = TONES[status] ?? TONES.none;
    const Icon = ICONS[status] ?? Minus;
    const label = TONES[status] ? t(status) : status;

    return (
        <span
            data-testid="task-gate-chip"
            data-gate-status={status}
            title={label}
            className={cn(
                'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap',
                tone,
                className,
            )}
        >
            <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="font-medium uppercase tracking-wide">{label}</span>
            {status === 'red' && typeof failedCount === 'number' && failedCount > 0 && (
                <span className="font-mono">· {failedCount}</span>
            )}
        </span>
    );
}
