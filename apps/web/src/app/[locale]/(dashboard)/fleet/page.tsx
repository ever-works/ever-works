import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AlertTriangle } from 'lucide-react';
import { fleetAPI, type FleetNeedsALookResult, type FleetNodeView } from '@/lib/api/fleet';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { FLEET_FEATURE_FLAGS } from '@/components/fleet/registry';
import { FleetHubFrame } from '@/components/fleet/hub/FleetHubFrame';
import { FleetTelemetryOnMount } from '@/components/fleet/FleetTelemetryOnMount';
import { ComputerCards } from '@/components/fleet/overview/ComputerCards';
import { FleetEmptyState } from '@/components/fleet/overview/FleetEmptyState';
import { FleetOverviewBlocks } from '@/components/fleet/overview/FleetOverviewBlocks';
import { NeedsALookList } from '@/components/fleet/overview/NeedsALookList';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('fleet.hub');
    return { title: t('title') };
}

/**
 * Fleet hub (FL-01, FR-5 – FR-9, spec §5.2) — `/fleet`, the Overview tab:
 * "which of my computers need me?" first (the needs-a-look list), "what do I
 * have?" second (one card per computer, favourites first, virtual computers
 * under their host), and any Overview blocks other epics registered.
 *
 * The two reads fail independently (`allSettled`): a failed needs-a-look read
 * renders its own "Could not load…" with Try again above cards that still
 * render, and a failed node read says so without hiding the rest (U11).
 * Spends no tokens or credits (FR-37).
 */
export default async function FleetOverviewPage() {
    const t = await getTranslations('fleet');
    const [nodesResult, lookResult] = await Promise.allSettled([
        fleetAPI.listVisibleNodes(),
        fleetAPI.needsALook(),
    ]);
    const nodes: FleetNodeView[] = nodesResult.status === 'fulfilled' ? nodesResult.value : [];
    const nodesError =
        nodesResult.status === 'rejected'
            ? nodesResult.reason instanceof Error
                ? nodesResult.reason.message
                : t('overview.computers.loadFailed')
            : null;
    const look: FleetNeedsALookResult | null =
        lookResult.status === 'fulfilled' ? lookResult.value : null;
    const lookError =
        lookResult.status === 'rejected'
            ? lookResult.reason instanceof Error
                ? lookResult.reason.message
                : t('overview.needsALook.failed')
            : null;
    const flags = readFleetFeatureFlags(FLEET_FEATURE_FLAGS);
    const persisted = nodes.filter((node) => node.persisted);

    return (
        <FleetHubFrame active="overview">
            <FleetTelemetryOnMount
                event={{ name: 'fleet_hub_opened', properties: { tab: 'overview' } }}
            />
            {nodesError && (
                <div
                    role="alert"
                    className="mb-4 flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 p-3"
                    data-testid="fleet-overview-nodes-error"
                >
                    <AlertTriangle
                        className="w-5 h-5 text-warning shrink-0 mt-0.5"
                        aria-hidden="true"
                    />
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('overview.computers.loadFailed')}
                    </p>
                </div>
            )}
            {!nodesError && persisted.length === 0 ? (
                <FleetEmptyState />
            ) : (
                <div className="space-y-8">
                    <NeedsALookList initial={look} initialError={lookError} nodes={persisted} />
                    <FleetOverviewBlocks surface="hub" nodes={persisted} flags={flags} />
                    <ComputerCards nodes={persisted} />
                </div>
            )}
        </FleetHubFrame>
    );
}
