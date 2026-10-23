'use client';

import { useTranslations } from 'next-intl';
import { Cloud } from 'lucide-react';
import type { FleetNodeCloudView } from '@ever-works/contracts';
import type { FleetOverviewBlockProps } from '../registry';
import {
    CLOUD_PHASE_KEYS,
    CLOUD_PROGRESS,
    cloudDisplayState,
    formatMemory,
    formatSince,
    hourly,
    money,
    type CloudDisplayState,
} from './cloud.shared';

type Translate = ReturnType<typeof useTranslations<'fleet.cloud'>>;

/** The state half of the block's first line ("running 3 d 7 h", "powered off 2 h · still billed …"). */
function stateLine(t: Translate, state: CloudDisplayState, cloud: FleetNodeCloudView): string {
    const since = formatSince(cloud.powerStateAt) ?? '';
    switch (state) {
        case 'running':
            return t('block.running', { duration: since });
        case 'off':
            return cloud.billsWhileOff ? t('block.offBills', { duration: since }) : t('block.off', { duration: since });
        case 'poweringOff':
            return t('block.pending.poweringOff');
        case 'starting':
            return t('block.pending.starting');
        case 'destroying':
            return t('block.pending.destroying');
        case 'gone':
            return t('block.gone', { provider: cloud.providerName, duration: formatSince(cloud.goneAt) ?? since });
        case 'failed':
            return t('block.failed', { error: cloud.error ?? t('create.failed') });
        case 'unenrolled':
            return t('block.unenrolled', {
                duration: formatSince(cloud.machineCreatedAt) ?? '',
                rate: hourly(cloud.hourlyRateCents, cloud.currency),
            });
        case 'creating':
        default:
            return t('block.creating', {
                phase: t(`progress.${CLOUD_PHASE_KEYS[cloud.phase]}` as Parameters<typeof t>[0], { provider: cloud.providerName }),
            });
    }
}

/**
 * Cloud computers (FL-17, spec FR-15, §5.2, §5.3) — the **Cloud** block on a
 * cloud computer's Overview: where it is and what it is (provider · region ·
 * size), whether it is running, off, being created or gone, and what it costs —
 * per hour, this month, since created and the projected month — labelled as
 * estimates from list prices. While it is being created, the progress strip
 * (asking the provider → booting → installing → enrolling → online). Renders
 * nothing on a computer that is not a cloud computer. The power and destroy
 * acts are the header actions (`CloudComputerActions`).
 */
export default function CloudBlock({ nodes }: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.cloud');
    const node = nodes.length === 1 ? nodes[0] : null;
    const cloud = node?.cloud ?? null;
    if (!node || !cloud) return null;
    const state = cloudDisplayState(node, cloud);
    const currency = cloud.currency;
    const live = state !== 'gone' && state !== 'failed';
    const policy =
        cloud.idlePolicy.mode === 'nothing'
            ? t('block.idleNothing')
            : cloud.idlePolicy.mode === 'power-off'
              ? t('block.idlePowerOff', { hours: cloud.idlePolicy.afterHours })
              : t('block.idleTellMe', { hours: cloud.idlePolicy.afterHours });

    return (
        <section
            className="rounded-lg border border-border dark:border-border-dark p-4 text-sm"
            aria-labelledby="fleet-cloud-block-title"
            data-testid="fleet-cloud-block"
        >
            <h3 id="fleet-cloud-block-title" className="mb-2 flex items-center gap-2 font-semibold">
                <Cloud className="h-4 w-4" aria-hidden="true" />
                {t('block.title')}
            </h3>
            <p data-testid="fleet-cloud-block-line">
                {t('block.line', {
                    provider: cloud.providerName,
                    region: cloud.regionLabel,
                    vcpus: cloud.vcpus,
                    memory: formatMemory(cloud.memoryMiB),
                    disk: cloud.diskGiB,
                })}
                {' · '}
                <span data-testid="fleet-cloud-block-state">{stateLine(t, state, cloud)}</span>
            </p>
            {state === 'creating' ? (
                <ol className="mt-2 flex flex-wrap gap-3 text-xs" aria-label={t('progress.label')}>
                    {CLOUD_PROGRESS.map((phase) => {
                        const reached = CLOUD_PROGRESS.indexOf(phase) <= CLOUD_PROGRESS.indexOf(cloud.phase);
                        return (
                            <li
                                key={phase}
                                className={reached ? 'font-medium' : 'text-text-muted dark:text-text-muted-dark'}
                                aria-current={phase === cloud.phase ? 'step' : undefined}
                            >
                                {t(`progress.${CLOUD_PHASE_KEYS[phase]}` as Parameters<typeof t>[0], { provider: cloud.providerName })}
                            </li>
                        );
                    })}
                </ol>
            ) : null}
            {live ? (
                <p className="mt-1 tabular-nums" data-testid="fleet-cloud-block-cost">
                    {t('block.costs', {
                        hour: hourly(cloud.hourlyRateCents, currency),
                        month: money(cloud.cost.monthToDateCents, currency),
                        since: money(cloud.cost.sinceCreatedCents, currency),
                        projected: money(cloud.cost.projectedMonthCents, currency),
                    })}
                </p>
            ) : null}
            {typeof cloud.cost.providerMonthToDateCents === 'number' ? (
                <p className="mt-1 text-xs">
                    {t('block.providerMtd', {
                        provider: cloud.providerName,
                        amount: money(cloud.cost.providerMonthToDateCents, currency),
                    })}
                </p>
            ) : null}
            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                {t('block.disclaimer', { provider: cloud.providerName })}
            </p>
            {live ? (
                <p className="mt-1 text-xs" data-testid="fleet-cloud-block-idle">
                    {t('block.idlePolicy', { policy })}
                </p>
            ) : null}
            {cloud.ipv4 ? (
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('block.address', { ip: cloud.ipv4 })}
                </p>
            ) : null}
        </section>
    );
}
