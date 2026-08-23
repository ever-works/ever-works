import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { creditsAPI } from '@/lib/api/credits';
import { costsAPI } from '@/lib/api/costs';
import { usageAPI, type AccountWideUsage } from '@/lib/api/usage';
import {
    currentUsageMonth,
    parseUsagePeriod,
    type CreditsPricing,
    type UsageSummaryGrouped,
    type UsageSummaryTotals,
} from '@/lib/api/credits.shared';
import {
    COSTS_DEFAULT_WINDOW_DAYS,
    parseCostsWindowDays,
    type CostsByAgent,
    type CostsByModel,
    type CostsDaily,
    type CostsSummary,
    type CostsTopRuns,
} from '@/lib/api/costs.shared';
import { parseUsageTab, USAGE_TAB_COSTS } from '@/lib/api/usage-tabs.shared';
import { UsageCreditsSettings } from '@/components/settings/UsageCreditsSettings';
import { UsageTabs } from '@/components/settings/usage/UsageTabs';
import { CostsSettings } from '@/components/settings/costs/CostsSettings';

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
 *
 * Costs tab — `?tab=costs` renders the Costs dashboard instead: total AI
 * spend for a rolling 7/30/90-day window, daily spend stacked by Agent,
 * per-Agent and per-model breakdowns and the most expensive runs. The
 * two tabs fetch DISJOINT endpoint sets and only the active one is
 * loaded, so adding this tab costs the Overview arm nothing.
 */
export default async function UsageSettingsPage({ searchParams }: UsageSettingsPageProps) {
    const params = await searchParams;
    const tab = parseUsageTab(params.tab);

    if (tab === USAGE_TAB_COSTS) {
        const windowDays = parseCostsWindowDays(params.windowDays) ?? COSTS_DEFAULT_WINDOW_DAYS;

        // Same per-call `.catch(() => null)` posture as the Overview arm:
        // one failing aggregation must degrade its own panel, not blank
        // the page.
        const [summary, daily, byAgent, byModel, topRuns] = await Promise.all([
            costsAPI.summary({ windowDays }).catch((): CostsSummary | null => null),
            costsAPI.daily({ windowDays }).catch((): CostsDaily | null => null),
            costsAPI.byAgent({ windowDays }).catch((): CostsByAgent | null => null),
            costsAPI.byModel({ windowDays }).catch((): CostsByModel | null => null),
            costsAPI.topRuns({ windowDays }).catch((): CostsTopRuns | null => null),
        ]);

        return (
            <UsageTabs active={USAGE_TAB_COSTS}>
                <CostsSettings
                    initialWindowDays={windowDays}
                    initialSnapshot={{ summary, daily, byAgent, byModel, topRuns }}
                />
            </UsageTabs>
        );
    }

    const period = parseUsagePeriod(params.period) ?? currentUsageMonth();

    const [totals, byDay, byModel, byAgent, byWork, accountWide, pricing] = await Promise.all([
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
        // Billing spec FR-13 — how a credit is priced, so the tiles never
        // show a number the page cannot explain.
        creditsAPI.pricing().catch((): CreditsPricing | null => null),
    ]);

    return (
        <UsageTabs active="overview">
            <UsageCreditsSettings
                initialPeriod={period}
                initialTotals={totals}
                initialByDay={byDay}
                initialByModel={byModel}
                initialByAgent={byAgent}
                initialByWork={byWork}
                accountWide={accountWide}
                pricing={pricing}
            />
        </UsageTabs>
    );
}
