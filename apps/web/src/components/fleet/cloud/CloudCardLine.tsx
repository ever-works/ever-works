'use client';

import { useTranslations } from 'next-intl';
import type { FleetNodeView } from '@ever-works/contracts';
import { CLOUD_PHASE_KEYS, cloudDisplayState, money } from './cloud.shared';

/**
 * Cloud computers (FL-17, spec §0, §5.2) — the line a cloud computer's card
 * carries in the hub: "Cloud computer · <provider> · nyc3 · $24/mo · $3.10",
 * plus its create phase, failure, gone or off state. Rendered by FL-01's
 * `ComputerCards` for a row with a Cloud block; nothing otherwise.
 */
export function CloudCardLine({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.cloud');
    const cloud = node.cloud;
    if (!cloud) return null;
    const state = cloudDisplayState(node, cloud);
    const base = t('card.line', {
        provider: cloud.providerName,
        region: cloud.regionId,
        month: money(cloud.monthlyPriceCents, cloud.currency),
        cost: money(cloud.cost.sinceCreatedCents, cloud.currency),
    });
    let suffix: string | null = null;
    if (state === 'creating') suffix = t(`progress.${CLOUD_PHASE_KEYS[cloud.phase]}` as Parameters<typeof t>[0], { provider: cloud.providerName });
    else if (state === 'failed') suffix = t('card.failed');
    else if (state === 'gone') suffix = t('card.gone', { provider: cloud.providerName });
    else if (state === 'unenrolled') suffix = t('card.unenrolled');
    else if (state === 'off') suffix = t('card.off');
    return (
        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-cloud-card-line">
            {base}
            {suffix ? ` · ${suffix}` : ''}
        </p>
    );
}
