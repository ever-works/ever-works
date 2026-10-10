import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { InstanceStatsReportView, InstanceStatsStatus } from '@ever-works/contracts';
import { isInstanceStatsOperatorStatus } from '@ever-works/contracts';
import { UsageStatisticsSettings } from '@/components/settings/UsageStatisticsSettings';
import { ApiResponseError } from '@/lib/api/server-api';
import { instanceStatsAPI } from '@/lib/api/instance-stats';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.everPlatform');
    return { title: t('title') };
}

/**
 * Settings → Ever Platform. Today it holds one section, Anonymous usage
 * statistics; the Ever Platform connection sections join it later.
 *
 * Two views, decided by the API: the platform admin gets the full section
 * (state, what is sent, the last payload, Send now, the switch, Reset
 * identity); anyone else gets whether statistics are on and who manages them.
 * When the API answers 404 the module is switched off for this installation by
 * its configuration (off unless `EVER_STATS_ENABLED=true`): there is no feature to show,
 * so the page answers 404 too (and the settings nav has no tab for it).
 */
export default async function EverPlatformSettingsPage() {
    let status: InstanceStatsStatus | null = null;
    let state: 'loaded' | 'unavailable' = 'loaded';
    try {
        status = await instanceStatsAPI.status();
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) notFound();
        state = 'unavailable';
    }

    let last: InstanceStatsReportView | null = null;
    if (status && isInstanceStatsOperatorStatus(status)) {
        last = await instanceStatsAPI
            .last()
            .then((result) => result.report)
            .catch(() => null);
    }

    return <UsageStatisticsSettings state={state} initialStatus={status} initialLast={last} />;
}
