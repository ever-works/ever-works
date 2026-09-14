'use client';

import { useTranslations } from 'next-intl';
import type { FeedKind } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

/** Colour is a second cue only — every pill always carries its text label. */
const KIND_TONE: Record<FeedKind, { dot: string; pill: string }> = {
    work: { dot: 'bg-info', pill: 'bg-info/10 text-info' },
    decision: { dot: 'bg-warning', pill: 'bg-warning/10 text-warning' },
    delivery: { dot: 'bg-success', pill: 'bg-success/10 text-success' },
    problem: { dot: 'bg-danger', pill: 'bg-danger/10 text-danger' },
    system: {
        dot: 'bg-text-muted dark:bg-text-muted-dark',
        pill: 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark',
    },
};

export function FeedKindPill({ kind, className }: { kind: FeedKind; className?: string }) {
    const t = useTranslations('dashboard.feed.kinds');
    const tone = KIND_TONE[kind] ?? KIND_TONE.system;
    return (
        <span
            data-testid="feed-kind-pill"
            data-kind={kind}
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                tone.pill,
                className,
            )}
        >
            <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
            {t(kind)}
        </span>
    );
}
