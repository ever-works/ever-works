'use client';

import { useTranslations } from 'next-intl';
import { Ban, CheckCircle2, CircleSlash, Clock, Loader2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppBuildStatus } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/**
 * APW-05 T26 — one Build's status: an icon plus text, never colour alone
 * (spec §6.6).
 */
const STATUS_STYLE: Record<AppBuildStatus, { icon: LucideIcon; tone: string; spin?: boolean }> = {
    queued: {
        icon: Clock,
        tone: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
    },
    running: {
        icon: Loader2,
        tone: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
        spin: true,
    },
    succeeded: {
        icon: CheckCircle2,
        tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    failed: {
        icon: XCircle,
        tone: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    },
    cancelled: {
        icon: CircleSlash,
        tone: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400',
    },
    blocked: {
        icon: Ban,
        tone: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    },
};

export function AppBuildStatusChip({
    status,
    className,
}: {
    status: AppBuildStatus;
    className?: string;
}) {
    const t = useTranslations('dashboard.workDetail.builds.status');
    const style = STATUS_STYLE[status] ?? STATUS_STYLE.queued;
    const Icon = style.icon;
    return (
        <span
            data-testid={`app-build-status-${status}`}
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
                style.tone,
                className,
            )}
        >
            <Icon className={cn('h-3.5 w-3.5', style.spin && 'animate-spin')} aria-hidden="true" />
            {t(status)}
        </span>
    );
}
