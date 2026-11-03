'use client';

import { useTranslations } from 'next-intl';
import type { TaskDeliveryDeployOutcome, TaskDeliveryState } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { safeWebUrl } from '@/lib/utils/safe-link';

/**
 * What a delivery chip reads — the list row's `delivery` embed and the Task page's
 * `TaskDeliveryView` both carry it (`outcome` is `view.deployment.outcome` there).
 */
export interface TaskDeliveryChipInput {
    state: TaskDeliveryState;
    liveUrl?: string | null;
    outcome?: TaskDeliveryDeployOutcome | string | null;
    liveWithWarnings?: boolean;
    carriedByLaterChange?: boolean;
}

type Tone = 'progress' | 'success' | 'failure' | 'neutral';

/** Status colour lives on the chip (a row badge), never on a KPI tile. */
const TONES: Record<Tone, string> = {
    progress: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300',
    success: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    failure: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    neutral: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
};

const STATE_TONES: Record<TaskDeliveryState, Tone> = {
    merged: 'progress',
    building: 'progress',
    build_failed: 'failure',
    built: 'progress',
    deploying: 'progress',
    deploy_failed: 'failure',
    live: 'success',
    closed_without_deploy: 'neutral',
};

type OutcomeKey = 'failed' | 'rolledBack' | 'rollbackFailed' | 'liveWithWarnings';

/** A `dashboard.tasksPage.delivery.*` chip leaf. */
export type DeliveryChipKey =
    | 'chipMerged'
    | 'chipBuilding'
    | 'chipBuildFailed'
    | 'chipBuilt'
    | 'chipDeploying'
    | 'chipDeployFailed'
    | 'chipDeployFailedPlain'
    | 'chipLive'
    | 'chipLiveWarnings'
    | 'chipCarried'
    | 'chipClosed';

/** `dashboard.tasksPage.delivery.outcome.*` leaf of an APW-06 failure outcome. */
const OUTCOME_KEYS: Record<TaskDeliveryDeployOutcome, OutcomeKey> = {
    failed: 'failed',
    rolled_back: 'rolledBack',
    rollback_failed: 'rollbackFailed',
    live_with_warnings: 'liveWithWarnings',
};

/** The `dashboard.tasksPage.delivery.*` leaf of the chip a delivery state reads. */
export function deliveryChipKey(input: TaskDeliveryChipInput): DeliveryChipKey {
    switch (input.state) {
        case 'merged':
            return 'chipMerged';
        case 'building':
            return 'chipBuilding';
        case 'build_failed':
            return 'chipBuildFailed';
        case 'built':
            return 'chipBuilt';
        case 'deploying':
            return 'chipDeploying';
        case 'deploy_failed':
            return input.outcome && input.outcome in OUTCOME_KEYS
                ? 'chipDeployFailed'
                : 'chipDeployFailedPlain';
        case 'live':
            if (input.liveWithWarnings) return 'chipLiveWarnings';
            if (input.carriedByLaterChange) return 'chipCarried';
            return 'chipLive';
        case 'closed_without_deploy':
            return 'chipClosed';
        default:
            return 'chipMerged';
    }
}

/**
 * APW-08 T52 (FR-71) — a delivery state's chip text, and its spoken form where that differs (a
 * failed Deployment's chip names its outcome in words for a screen reader). Shared by the chip and
 * the Delivery section's polite live region, so what is announced is exactly what the chip shows.
 */
export function useDeliveryChipText(): (delivery: TaskDeliveryChipInput) => {
    label: string;
    spoken: string;
} {
    const t = useTranslations('dashboard.tasksPage.delivery');
    return (delivery) => {
        const key = deliveryChipKey(delivery);
        const outcomeKey =
            delivery.outcome && delivery.outcome in OUTCOME_KEYS
                ? OUTCOME_KEYS[delivery.outcome as TaskDeliveryDeployOutcome]
                : null;
        const outcome = outcomeKey ? t(`outcome.${outcomeKey}`) : '';
        if (key === 'chipDeployFailed') {
            return {
                label: t('chipDeployFailed', { outcome }),
                spoken: t('ariaDeployFailed', { outcome }),
            };
        }
        const label = t(key);
        return { label, spoken: label };
    };
}

/**
 * APW-08 T27 (`TaskDeliveryChips`, spec §6.1) — where a merged App Work change stands, as a
 * board / list chip: `Merged ✓ · Waiting for a build` → `Build ⟳` → `Built ✓ · Waiting for a
 * deployment` → `Deploying ⟳` → `Live ✓`, or a failure / `Closed without deploying`. Rendered
 * after `GateChip` only when the row carries a delivery embed (an App Work Task the chain
 * tracks); a live chip with a URL links to the live app.
 */
export function TaskDeliveryChips({
    delivery,
    linkLive = true,
    className,
}: {
    delivery: TaskDeliveryChipInput | null | undefined;
    /**
     * Render a live chip as a link to the live app. Off where the chip sits INSIDE another
     * link (the list's Task card is one `<a>`; an anchor inside an anchor is invalid HTML).
     */
    linkLive?: boolean;
    className?: string;
}) {
    const t = useTranslations('dashboard.tasksPage.delivery');
    const chipText = useDeliveryChipText();
    if (!delivery || !(delivery.state in STATE_TONES)) return null;

    const { label, spoken } = chipText(delivery);
    const ariaLabel = spoken !== label ? spoken : undefined;
    const tone = TONES[STATE_TONES[delivery.state]];
    // A deployment target may serve plain http; anything else (`javascript:` …) renders inert.
    const liveUrl = delivery.state === 'live' && linkLive ? safeWebUrl(delivery.liveUrl) : null;

    const chipClass = cn(
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap font-medium',
        tone,
        className,
    );

    if (liveUrl) {
        return (
            <a
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="task-delivery-chip"
                data-delivery-state={delivery.state}
                title={t('liveAt', { url: liveUrl })}
                onClick={(event) => event.stopPropagation()}
                className={cn(chipClass, 'hover:underline')}
            >
                {label}
                <span aria-hidden="true">↗</span>
            </a>
        );
    }

    return (
        <span
            data-testid="task-delivery-chip"
            data-delivery-state={delivery.state}
            title={ariaLabel ?? label}
            aria-label={ariaLabel}
            className={chipClass}
        >
            {label}
        </span>
    );
}
