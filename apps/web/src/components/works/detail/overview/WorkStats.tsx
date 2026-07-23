'use client';

import { Work } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { getGenerationStatusConfig } from '@/lib/utils/generation-status';
import { useTranslations } from 'next-intl';
import { useWorkDetail } from '../WorkDetailContext';
import {
    getWorkCapabilities,
    WORK_METRIC_DEFINITIONS,
    type WorkMetricId,
    type WorkMetricState,
} from '@ever-works/contracts';
import { WORK_METRIC_PRESENTATION } from './work-metric-presentation';
import { resolveWorkMetrics } from './resolve-work-metrics';

interface WorkStatsProps {
    work: Work;
    itemsCount: number;
    categoriesCount: number;
    tagsCount: number;
    comparisonsCount: number;
}

interface StatCardProps {
    title: string;
    value: string | number;
    icon: React.ReactNode;
    iconColor: string;
    className?: string;
    /** Stable id for e2e selectors; also keys the React list. */
    metricId?: WorkMetricId;
    /** Shown under the value when the metric could not be resolved. */
    hint?: string;
}

function StatCard({ title, value, icon, iconColor, className, metricId, hint }: StatCardProps) {
    return (
        <div
            className={cn(
                'rounded-lg p-1',
                'bg-card/10 dark:bg-card-primary-dark/30',
                'border border-card-border dark:border-border-secondary-dark',
                'w-full',
                'min-w-0',
            )}
            data-testid={metricId ? `work-stat-tile-${metricId}` : undefined}
        >
            <div
                className={cn(
                    'relative rounded-sm overflow-hidden h-full',
                    'min-w-0',
                    'bg-card dark:bg-card-primary-dark',
                    'border border-card-border dark:border-border-dark',
                    'px-3 py-2 sm:px-5 sm:py-2',
                )}
            >
                <p className="text-xs sm:text-sm text-text-muted dark:text-text-muted-dark">
                    {title}
                </p>
                <p
                    className={cn(
                        'text-xl sm:text-2xl font-bold text-text dark:text-text-dark mt-2 break-words whitespace-normal',
                        className,
                    )}
                    data-testid={metricId ? `work-stat-value-${metricId}` : undefined}
                >
                    {value}
                </p>
                {hint && (
                    <p className="mt-0.5 text-[11px] leading-tight text-text-muted dark:text-text-muted-dark">
                        {hint}
                    </p>
                )}

                <div className="absolute top-2 sm:top-3 right-2 sm:right-3">
                    <span className={cn(iconColor, 'block')}>{icon}</span>
                </div>
            </div>
        </div>
    );
}

function getGenerationStatusStat(
    work: Work,
    t: ReturnType<typeof useTranslations>,
    tStatus: ReturnType<typeof useTranslations>,
) {
    const hasWarnings = !!work.generateStatus?.warnings?.length;
    const config = getGenerationStatusConfig(work.generateStatus?.status, { hasWarnings });
    const Icon = config.icon;

    return {
        title: t('generationStatus'),
        value: tStatus(config.labelKey),
        icon: <Icon className={cn('w-3 h-3 sm:w-4 sm:h-4', config.animate && 'animate-spin')} />,
        iconColor: config.stat.iconColor,
        className: config.labelKey === 'generatedWithWarnings' ? 'sm:text-xl' : undefined,
    };
}

/**
 * Which tiles a Work shows depends on what kind of Work it is.
 *
 * Every Work used to render the same five directory-shaped tiles, so a
 * Landing Page reported "Total Items: 0 / Categories: 0 / Comparisons: 0"
 * forever — three numbers that can never become anything else. The tile set
 * now comes from the shared capability registry
 * (`getWorkCapabilities(kind).metrics`).
 *
 * `default`-kind Works — which is effectively the entire installed base —
 * keep exactly the previous five tiles, in the previous order.
 */
export function WorkStats({
    categoriesCount,
    itemsCount,
    tagsCount,
    comparisonsCount,
    work,
}: WorkStatsProps) {
    const t = useTranslations('dashboard.workDetail.stats');
    const tStatus = useTranslations('dashboard.workDetail.status');
    const { work: syncedWork } = useWorkDetail();
    const statusWork = syncedWork.id === work.id ? syncedWork : work;

    const metricIds = getWorkCapabilities(work.kind).metrics;
    const generationStat = getGenerationStatusStat(statusWork, t, tStatus);

    const values = resolveWorkMetrics(metricIds, {
        itemsCount,
        categoriesCount,
        tagsCount,
        comparisonsCount,
        createdAt: work.createdAt,
        hasDeployment: Boolean(work.website),
        generationStatusLabel: String(generationStat.value),
        deployStatusLabel: t('states.live'),
    });

    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-4 w-full h-auto">
            {values.map((metric) => {
                const definition = WORK_METRIC_DEFINITIONS[metric.id];
                const presentation = WORK_METRIC_PRESENTATION[metric.id];

                // The generation-status tile keeps its bespoke status icon,
                // colour and small-text treatment.
                if (metric.id === 'generation-status') {
                    return (
                        <StatCard
                            key={metric.id}
                            metricId={metric.id}
                            title={generationStat.title}
                            value={generationStat.value}
                            icon={generationStat.icon}
                            iconColor={generationStat.iconColor}
                            className={generationStat.className}
                        />
                    );
                }

                const Icon = presentation.icon;
                const unavailable = metric.state !== 'ok';

                return (
                    <StatCard
                        key={metric.id}
                        metricId={metric.id}
                        title={t(definition.labelKey)}
                        // An unresolved metric shows an em-dash, never a
                        // fabricated 0 — "no data yet" and "zero" are
                        // different claims.
                        value={unavailable ? '—' : (metric.value ?? '—')}
                        hint={unavailable ? t(STATE_HINT_KEY[metric.state]) : undefined}
                        icon={<Icon className="w-3 h-3 sm:w-4 sm:h-4" />}
                        iconColor={unavailable ? 'text-text-muted' : presentation.iconColor}
                        className={
                            unavailable ? 'text-text-muted dark:text-text-muted-dark' : undefined
                        }
                    />
                );
            })}
        </div>
    );
}

/**
 * Maps an unresolved metric state to its `stats.states.*` message key.
 *
 * The value type is a literal union, not `string`, so next-intl can still
 * verify the composed key against the message catalogue.
 */
const STATE_HINT_KEY: Record<
    Exclude<WorkMetricState, 'ok'>,
    'states.notConfigured' | 'states.notDeployed' | 'states.notGenerated' | 'states.unavailable'
> = {
    not_configured: 'states.notConfigured',
    not_deployed: 'states.notDeployed',
    not_generated: 'states.notGenerated',
    error: 'states.unavailable',
};
