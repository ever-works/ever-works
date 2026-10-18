import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FleetHubTabPage } from '@/components/fleet/hub/FleetHubTabPage';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('fleet.hub');
    return { title: `${t('tabs.checkouts')} · ${t('title')}` };
}

/**
 * Fleet hub (FL-01, CONTRACTS §11.1) — `/fleet/checkouts`. FL-01 owns this route;
 * the epic that fills the tab registers its panel with `registerHubTab`
 * (`components/fleet/modules/`) and never adds a second page file.
 */
export default async function FleetCheckoutsPage() {
    return <FleetHubTabPage tab="checkouts" />;
}
