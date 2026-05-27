import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Unified dashboard page header. Mirrors the Skills/Tasks/Agents
 * pattern (icon tile + title + subtitle) so every catalog/index
 * page reads the same way regardless of which feature owns it.
 *
 * The icon tile colour is configurable via `tone`; the default
 * uses the neutral primary palette. `actions` is rendered on the
 * right side of the header row (e.g. "+ New X" CTA) and stays
 * pinned right when the title block shrinks.
 */
export type PageHeaderTone =
    | 'primary'
    | 'success'
    | 'info'
    | 'warning'
    | 'danger'
    | 'accent';

interface PageHeaderProps {
    icon: LucideIcon;
    title: string;
    subtitle?: string;
    tone?: PageHeaderTone;
    actions?: ReactNode;
    className?: string;
}

const toneClasses: Record<PageHeaderTone, { bg: string; border: string; text: string }> = {
    primary: {
        bg: 'bg-primary/10',
        border: 'border-primary/20',
        text: 'text-primary',
    },
    success: {
        bg: 'bg-success/10',
        border: 'border-success/20',
        text: 'text-success',
    },
    info: {
        bg: 'bg-info/10',
        border: 'border-info/20',
        text: 'text-info',
    },
    warning: {
        bg: 'bg-warning/10',
        border: 'border-warning/20',
        text: 'text-warning',
    },
    danger: {
        bg: 'bg-danger/10',
        border: 'border-danger/20',
        text: 'text-danger',
    },
    accent: {
        bg: 'bg-accent-indigo/10',
        border: 'border-accent-indigo/20',
        text: 'text-accent-indigo',
    },
};

export function PageHeader({
    icon: Icon,
    title,
    subtitle,
    tone = 'primary',
    actions,
    className,
}: PageHeaderProps) {
    const t = toneClasses[tone];
    return (
        <div className={cn('flex items-start justify-between gap-3 mb-6', className)}>
            <div className="flex items-start gap-3 min-w-0">
                <div
                    className={cn(
                        'shrink-0 w-9 h-9 rounded-lg flex items-center justify-center border',
                        t.bg,
                        t.border,
                    )}
                >
                    <Icon className={cn('w-4 h-4', t.text)} />
                </div>
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark truncate">
                        {title}
                    </h1>
                    {subtitle ? (
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                            {subtitle}
                        </p>
                    ) : null}
                </div>
            </div>
            {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
        </div>
    );
}
