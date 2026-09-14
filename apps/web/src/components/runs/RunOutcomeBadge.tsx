'use client';

import { useTranslations } from 'next-intl';
import { Ban, CheckCircle2, Clock, Loader2, XCircle, type LucideIcon } from 'lucide-react';
import {
    RUN_LEDGER_TRIGGER_KINDS,
    type RunLedgerStatus,
    type RunLedgerTriggerKind,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

const ICONS: Record<RunLedgerStatus, LucideIcon> = {
    queued: Clock,
    running: Loader2,
    completed: CheckCircle2,
    failed: XCircle,
    cancelled: Ban,
};

const TONES: Record<RunLedgerStatus, string> = {
    queued: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    running: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    completed: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    cancelled: 'bg-slate-100 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400',
};

/**
 * A run's outcome as an icon AND a text label — never colour alone, so the
 * outcome survives a screen reader, a monochrome display and colour-blind
 * viewers alike.
 */
export function RunOutcomeBadge({ status }: { status: RunLedgerStatus }) {
    const t = useTranslations('dashboard.runsPage.outcome');
    const Icon = ICONS[status] ?? Clock;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
                TONES[status] ?? TONES.queued,
            )}
            data-testid="run-outcome"
            data-status={status}
        >
            <Icon
                className={cn('w-3 h-3 shrink-0', status === 'running' && 'animate-spin')}
                aria-hidden
            />
            {ICONS[status] ? t(status) : status}
        </span>
    );
}

/** Localised trigger label for a run; an unrecognised token renders as itself. */
export function useRunTriggerLabel(): (kind: string) => string {
    const t = useTranslations('dashboard.runsPage.trigger');
    return (kind: string) =>
        (RUN_LEDGER_TRIGGER_KINDS as readonly string[]).includes(kind)
            ? t(kind as RunLedgerTriggerKind)
            : kind;
}
