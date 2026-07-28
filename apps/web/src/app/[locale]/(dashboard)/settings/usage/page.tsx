import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { creditsAPI } from '@/lib/api/credits';
import { usageAPI, type AccountWideUsage } from '@/lib/api/usage';
import {
    currentUsageMonth,
    parseUsagePeriod,
    type UsageSummaryGrouped,
    type UsageSummaryTotals,
} from '@/lib/api/credits.shared';
import { UsageCreditsSettings } from '@/components/settings/UsageCreditsSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('usage') };
}

interface UsageSettingsPageProps {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Wave 13 — Usage & Credits page (billing/usage PRD §4): period credit
 * summary tiles + consumption counts, and per-day / per-model /
 * per-agent / per-Work spend charts from the owner-scoped
 * `GET /api/credits/usage-summary` aggregations.
 *
 * B20 — ONE period drives every panel, and it accepts a `YYYY-MM`
 * calendar month as well as the rolling `7d` / `30d` windows. A
 * `?period=` deep link is honoured server-side (validated through
 * `parseUsagePeriod`, falling back to the current month), so a shared
 * link renders exactly the month it names; the client selector then
 * refetches through the `/api/credits/usage-summary` proxy.
 */
export default async function UsageSettingsPage({ searchParams }: UsageSettingsPageProps) {
    const params = await searchParams;
    const period = parseUsagePeriod(params.period) ?? currentUsageMonth();

    const [totals, byDay, byModel, byAgent, byWork, accountWide] = await Promise.all([
        creditsAPI.usageSummary({ period }).catch((): UsageSummaryTotals | null => null),
        creditsAPI
            .usageGrouped({ groupBy: 'day', period })
            .catch((): UsageSummaryGrouped | null => null),
        creditsAPI
            .usageGrouped({ groupBy: 'model', period })
            .catch((): UsageSummaryGrouped | null => null),
        creditsAPI
            .usageGrouped({ groupBy: 'agent', period })
            .catch((): UsageSummaryGrouped | null => null),
        creditsAPI
            .usageGrouped({ groupBy: 'work', period })
            .catch((): UsageSummaryGrouped | null => null),
        usageAPI.accountWide().catch((): AccountWideUsage | null => null),
    ]);

    return (
        <UsageCreditsSettings
            initialPeriod={period}
            initialTotals={totals}
            initialByDay={byDay}
            initialByModel={byModel}
            initialByAgent={byAgent}
            initialByWork={byWork}
            accountWide={accountWide}
        />
    );
}
