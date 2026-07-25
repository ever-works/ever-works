import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { creditsAPI } from '@/lib/api/credits';
import { usageAPI, type AccountWideUsage } from '@/lib/api/usage';
import type { UsageSummaryGrouped, UsageSummaryTotals } from '@/lib/api/credits.shared';
import { UsageCreditsSettings } from '@/components/settings/UsageCreditsSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('usage') };
}

/**
 * Wave 13 — Usage & Credits page (billing/usage PRD §4): period credit
 * summary tiles + consumption counts, and per-day / per-model /
 * per-agent / per-Work spend charts from the owner-scoped
 * `GET /api/credits/usage-summary` aggregations.
 *
 * Server component fetches the initial snapshot (current month for the
 * grouped charts, 30d for the by-day chart); the client's 7d/30d
 * toggle refetches through the `/api/credits/usage-summary` proxy.
 * Static page by design — no polling; refresh on navigation.
 */
export default async function UsageSettingsPage() {
    const [totals, byDay, byModel, byAgent, byWork, accountWide] = await Promise.all([
        creditsAPI.usageSummary().catch((): UsageSummaryTotals | null => null),
        creditsAPI
            .usageGrouped({ groupBy: 'day', period: '30d' })
            .catch((): UsageSummaryGrouped | null => null),
        creditsAPI.usageGrouped({ groupBy: 'model' }).catch((): UsageSummaryGrouped | null => null),
        creditsAPI.usageGrouped({ groupBy: 'agent' }).catch((): UsageSummaryGrouped | null => null),
        creditsAPI.usageGrouped({ groupBy: 'work' }).catch((): UsageSummaryGrouped | null => null),
        usageAPI.accountWide().catch((): AccountWideUsage | null => null),
    ]);

    return (
        <UsageCreditsSettings
            initialTotals={totals}
            initialByDay={byDay}
            initialByModel={byModel}
            initialByAgent={byAgent}
            initialByWork={byWork}
            accountWide={accountWide}
        />
    );
}
