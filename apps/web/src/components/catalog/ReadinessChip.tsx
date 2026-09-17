import { useTranslations } from 'next-intl';
import { CheckCircle2, CircleDashed, CircleSlash, PlugZap } from 'lucide-react';
import type { PlaybookReadinessState } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

const STYLES: Record<PlaybookReadinessState, { icon: typeof CheckCircle2; className: string }> = {
    ready: { icon: CheckCircle2, className: 'bg-success/10 text-success border-success/20' },
    needs_connection: { icon: PlugZap, className: 'bg-warning/10 text-warning border-warning/20' },
    adopted: { icon: CircleDashed, className: 'bg-info/10 text-info border-info/20' },
    blocked: {
        icon: CircleSlash,
        className:
            'bg-surface-secondary dark:bg-white/9 text-text-secondary dark:text-text-secondary-dark border-border dark:border-border-dark',
    },
};

/** The text a readiness state reads as — shared by the chip and the card's accessible name. */
export function useReadinessLabel() {
    const t = useTranslations('dashboard.catalogPage.readiness');
    return (state: PlaybookReadinessState, missingCount: number): string => {
        switch (state) {
            case 'ready':
                return t('ready');
            case 'needs_connection':
                return t('needsConnection', { count: missingCount });
            case 'adopted':
                return t('adopted');
            default:
                return t('notAvailable');
        }
    };
}

/**
 * A playbook's readiness for this workspace. The label is always text, with
 * an icon beside it — colour is decoration and never the only signal.
 */
export function ReadinessChip({
    state,
    missingCount,
    className,
}: {
    state: PlaybookReadinessState;
    missingCount: number;
    className?: string;
}) {
    const label = useReadinessLabel();
    const { icon: Icon, className: tone } = STYLES[state];
    return (
        <span
            data-testid="readiness-chip"
            data-state={state}
            className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                tone,
                className,
            )}
        >
            <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
            {label(state, missingCount)}
        </span>
    );
}
