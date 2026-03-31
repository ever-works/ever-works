'use client';

import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';

const STATUS_CONFIG: Record<string, { icon: typeof Clock; color: string; bg: string }> = {
    pending: {
        icon: Clock,
        color: 'text-text-muted dark:text-text-muted-dark',
        bg: 'bg-surface-secondary dark:bg-surface-secondary-dark',
    },
    in_progress: {
        icon: Loader2,
        color: 'text-blue-600 dark:text-blue-400',
        bg: 'bg-blue-50 dark:bg-blue-900/20',
    },
    completed: {
        icon: CheckCircle2,
        color: 'text-green-600 dark:text-green-400',
        bg: 'bg-green-50 dark:bg-green-900/20',
    },
    failed: {
        icon: XCircle,
        color: 'text-red-600 dark:text-red-400',
        bg: 'bg-red-50 dark:bg-red-900/20',
    },
};

export function ActivityStatusBadge({ status }: { status: string }) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
    const Icon = config.icon;
    const isSpinning = status === 'in_progress';

    return (
        <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.color} ${config.bg}`}
        >
            <Icon className={`w-3 h-3 ${isSpinning ? 'animate-spin' : ''}`} />
            {status.replaceAll('_', ' ')}
        </span>
    );
}
