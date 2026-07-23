'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { normalizeWorkKind, WORK_KIND_PRESENTATION } from '@/lib/work-kinds/catalog';

interface WorkKindBadgeProps {
    /** Raw `work.kind` straight off the API. Unknown values degrade to "Work". */
    kind?: string | null;
    /**
     * `pill` — standalone rounded chip, used on cards and in the Work
     * Information block. `inline` — icon + text only, sized to sit in the
     * Work header's meta row next to the slug / owner / provider entries.
     */
    variant?: 'pill' | 'inline';
    className?: string;
}

/**
 * Renders a Work's type (kind) as a badge.
 *
 * Colour and icon come from the shared catalog in
 * `@/lib/work-kinds/catalog` so a Work reads the same on the works grid,
 * the detail header and the info block.
 */
export function WorkKindBadge({ kind, variant = 'pill', className }: WorkKindBadgeProps) {
    const t = useTranslations('dashboard.workKind');
    const normalized = normalizeWorkKind(kind);
    const { icon: Icon, tone } = WORK_KIND_PRESENTATION[normalized];
    const label = t(normalized);

    if (variant === 'inline') {
        return (
            <div
                className={cn(
                    'flex items-center gap-1 text-[11px] text-text-secondary dark:text-text-secondary-dark',
                    className,
                )}
                data-testid="work-kind-badge"
                data-work-kind={normalized}
                title={`${t('label')}: ${label}`}
            >
                <Icon className="w-3.5 h-3.5 opacity-60" />
                <span>{label}</span>
            </div>
        );
    }

    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0',
                tone,
                className,
            )}
            data-testid="work-kind-badge"
            data-work-kind={normalized}
            title={`${t('label')}: ${label}`}
        >
            <Icon className="w-3 h-3 shrink-0" />
            {label}
        </span>
    );
}
