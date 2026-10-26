'use client';

import { useTranslations } from 'next-intl';
import type { FleetUsageTaskCost } from '@ever-works/contracts';
import { usageMoney } from '../usage/usage.shared';

/**
 * Usage & cost on the fleet (FL-20 P2, spec FR-16) — an Agent-session
 * schedule row's cost: "last run $0.42 · 30 d $6.10 · list" from the computer's
 * usage scan, with the payer sentence as its tooltip. Nothing while the Task
 * never ran or nothing was scanned for it.
 */
export function ScheduleUsageCost({ cost }: { cost: FleetUsageTaskCost | null | undefined }) {
    const t = useTranslations('fleet.usage');
    if (!cost?.lastRun) return null;
    const last = usageMoney(cost.lastRun.costCents);
    const month = usageMoney(cost.last30DaysCents);
    if (!last && !month) return null;
    return (
        <span
            className="text-xs tabular-nums text-text-muted dark:text-text-muted-dark"
            title={t('payerNote')}
            data-testid="fleet-schedule-usage-cost"
        >
            {t('schedule.cost', { last: last ?? t('schedule.none'), month: month ?? t('schedule.none') })}
        </span>
    );
}
