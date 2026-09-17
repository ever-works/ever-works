'use client';

import { CircleHelp, Flag, Gavel, Hand } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type {
    HomeBlock,
    HomeDecisionKind,
    HomeDecisionRow,
    HomeDecisions,
} from '@ever-works/contracts';
import { AttentionSection } from '@/components/dashboard/AttentionSection';
import type { AttentionItem } from '@/components/dashboard/dashboard-signals.types';
import { Link } from '@/i18n/navigation';
import { buildDecisionsHref } from '@/lib/api/inbox.shared';
import { cn } from '@/lib/utils/cn';
import { HomeBlockShell } from './HomeBlockShell';
import { formatCount, formatWaiting, HOME_ALSO_BROKEN_MAX, homeWaitingTone } from './home.shared';

const KIND_ICON: Record<HomeDecisionKind, typeof Gavel> = {
    approval: Gavel,
    question: CircleHelp,
    escalation: Flag,
};

const TONE_CLASS = {
    neutral:
        'bg-surface-secondary text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
} as const;

interface NeedsYouBlockProps {
    block: HomeBlock<HomeDecisions> | undefined;
    /** Failures the platform raised on its own — shown under `Also broken`, never counted. */
    alsoBroken: AttentionItem[];
    onRetry?: () => void;
}

/**
 * Home (AW-19) — what is blocked on the human: the head of the My Decisions
 * queue, in its own order, with how long each has waited. Every row opens the
 * decision in My Decisions; answering in place arrives with the next phase.
 *
 * Titles are agent-authored and render as plain text.
 */
export function NeedsYouBlock({ block, alsoBroken, onRetry }: NeedsYouBlockProps) {
    const t = useTranslations('dashboard.home');
    const tAttention = useTranslations('dashboard.attention');
    const data = block?.status === 'ok' ? block.data : null;
    const state = !block
        ? 'loading'
        : block.status === 'failed' || !data
          ? 'failed'
          : data.total === 0
            ? 'empty'
            : 'ready';
    const broken = alsoBroken.slice(0, HOME_ALSO_BROKEN_MAX);
    const remaining = data ? Math.max(0, data.total - data.rows.length) : 0;

    return (
        <div className="space-y-3">
            <HomeBlockShell
                blockId="needsYou"
                title={t('needsYou.title')}
                icon={Hand}
                state={state}
                failedLabel={t('block.names.needsYou')}
                onRetry={onRetry}
                titleSuffix={
                    data && data.overdueCount > 0 ? (
                        <span
                            aria-live="polite"
                            data-testid="home-needs-you-overdue"
                            className="text-xs font-medium text-danger"
                        >
                            · {t('needsYou.overdue', { count: formatCount(data.overdueCount) })}
                        </span>
                    ) : null
                }
                headerAction={
                    data && data.total > 0 ? (
                        <Link
                            href={buildDecisionsHref({ tab: 'open' })}
                            className="font-medium text-primary hover:underline"
                            data-testid="home-needs-you-open-all"
                        >
                            {t('needsYou.openAll', { count: formatCount(data.total) })} →
                        </Link>
                    ) : null
                }
                empty={
                    <div>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('needsYou.emptyTitle')}
                        </p>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('needsYou.emptyBody')}
                        </p>
                    </div>
                }
                skeletonRows={3}
            >
                {data ? (
                    <>
                        <ul className="divide-y divide-border/40 dark:divide-white/6">
                            {data.rows.map((row) => (
                                <DecisionRow key={row.id} row={row} />
                            ))}
                        </ul>
                        {remaining > 0 ? (
                            <p className="mt-2 text-center text-xs text-text-muted dark:text-text-muted-dark">
                                {t('needsYou.moreWaiting', { count: formatCount(remaining) })}
                            </p>
                        ) : null}
                    </>
                ) : null}
            </HomeBlockShell>

            {broken.length > 0 ? (
                <div data-testid="home-also-broken">
                    <AttentionSection items={broken} title={tAttention('alsoBroken')} />
                </div>
            ) : null}
        </div>
    );
}

function DecisionRow({ row }: { row: HomeDecisionRow }) {
    const t = useTranslations('dashboard.home.needsYou');
    const Icon = KIND_ICON[row.kind];
    const waiting = formatWaiting(row.waitingMs);
    const tone = homeWaitingTone(row.waitingMs);
    const waitingLabel =
        waiting.unit === 'minutes'
            ? t('waitingMinutes', { count: waiting.count })
            : waiting.unit === 'hours'
              ? t('waitingHours', { count: waiting.count })
              : t('waitingDays', { count: waiting.count });

    return (
        <li
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            data-testid="home-decision-row"
        >
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-secondary px-1.5 py-0.5 text-[11px] font-medium text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark">
                <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                {t(`kinds.${row.kind}`)}
            </span>
            {row.agentName ? (
                <span className="shrink-0 text-xs text-text-secondary dark:text-text-secondary-dark">
                    {row.agentName}
                </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm text-text dark:text-text-dark">
                {row.title}
            </span>
            {row.blocking ? (
                <span className="shrink-0 text-[11px] font-medium text-warning">
                    {t('blocking')}
                </span>
            ) : null}
            <span
                data-tone={tone}
                className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums',
                    TONE_CLASS[tone],
                )}
            >
                {waitingLabel}
            </span>
            <Link
                href={buildDecisionsHref({ tab: 'open' }, row.id)}
                className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs font-medium text-text hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:border-white/12 dark:text-text-dark"
            >
                {t('open')}
            </Link>
        </li>
    );
}
