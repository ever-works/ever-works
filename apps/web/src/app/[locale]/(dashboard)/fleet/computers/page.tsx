import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { isFleetEnrollableNodeKind } from '@ever-works/contracts';
import {
    fleetAPI,
    type FleetEnrollmentTokenView,
    type FleetExecutionPreferenceView,
    type FleetNodeView,
} from '@/lib/api/fleet';
import { resolveFleetDownloadUrls, resolvePublicApiBaseUrl } from '@/lib/fleet-flags';
import { FleetHubFrame } from '@/components/fleet/hub/FleetHubFrame';
import { FleetComputersPanel } from '@/components/fleet/computers/FleetComputersPanel';
import { FleetTelemetryOnMount } from '@/components/fleet/FleetTelemetryOnMount';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('fleet.hub');
    return { title: `${t('tabs.computers')} · ${t('title')}` };
}

/**
 * Fleet hub (FL-01, FR-10, spec S4) — `/fleet/computers`: the machine table,
 * the Add computer flow and the node drawer that used to sit under Settings →
 * Fleet, with the same reads as that page (each failing on its own). `?add=`
 * (from "Add computer ▾") opens the Add flow preset to that kind.
 */
export default async function FleetComputersPage({
    searchParams,
}: {
    searchParams: Promise<{ add?: string | string[] }>;
}) {
    const { add } = await searchParams;
    const addKind = Array.isArray(add) ? add[0] : add;

    let initialNodes: FleetNodeView[] = [];
    let loadError: string | null = null;
    let initialTokens: FleetEnrollmentTokenView[] = [];
    let tokensError: string | null = null;
    let initialPreferences: FleetExecutionPreferenceView[] = [];
    let preferencesError: string | null = null;

    // `allSettled`, exactly as Settings → Fleet reads them: a token-list
    // hiccup must not take the machine table down.
    const [nodesResult, tokensResult, preferencesResult] = await Promise.allSettled([
        fleetAPI.listNodes(),
        fleetAPI.listOutstandingTokens(),
        fleetAPI.listExecutionPreferences(),
    ]);
    if (nodesResult.status === 'fulfilled') initialNodes = nodesResult.value;
    else
        loadError =
            nodesResult.reason instanceof Error
                ? nodesResult.reason.message
                : 'Failed to load fleet nodes';
    if (tokensResult.status === 'fulfilled') initialTokens = tokensResult.value;
    else
        tokensError =
            tokensResult.reason instanceof Error
                ? tokensResult.reason.message
                : 'Failed to load outstanding enrollment tokens';
    if (preferencesResult.status === 'fulfilled') initialPreferences = preferencesResult.value;
    else
        preferencesError =
            preferencesResult.reason instanceof Error
                ? preferencesResult.reason.message
                : 'Failed to load execution preferences';

    const downloads = resolveFleetDownloadUrls();

    return (
        <FleetHubFrame active="computers">
            <FleetTelemetryOnMount
                event={{ name: 'fleet_hub_opened', properties: { tab: 'computers' } }}
            />
            <FleetComputersPanel
                initialNodes={initialNodes}
                loadError={loadError}
                initialTokens={initialTokens}
                tokensError={tokensError}
                apiBaseUrl={resolvePublicApiBaseUrl()}
                desktopDownloadUrl={downloads.desktop}
                nodeDownloadUrl={downloads.node}
                initialPreferences={initialPreferences}
                preferencesError={preferencesError}
                openAddKind={isFleetEnrollableNodeKind(addKind) ? addKind : null}
            />
        </FleetHubFrame>
    );
}
