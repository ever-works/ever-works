import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
    fleetAPI,
    type FleetEnrollmentTokenView,
    type FleetExecutionPreferenceView,
    type FleetKillSwitchState,
    type FleetNodeView,
} from '@/lib/api/fleet';
import { FleetSettings } from '@/components/settings/FleetSettings';
import {
    isFleetEnabled,
    resolveFleetDownloadUrls,
    resolvePublicApiBaseUrl,
} from '@/lib/fleet-flags';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.fleet');
    return { title: t('title') };
}

/**
 * Fleet — settings page for the node registry: where the user's work
 * CAN run (Job Runtime, directly below in the menu, stays HOW work is
 * dispatched).
 *
 * Server component: fetches the merged node list (enrolled machines +
 * live nodes of the user's own configured clusters, tagged `k8s`) and
 * the outstanding enrollment tokens, then hands them to the client
 * component. Graceful degradation: each fetch fails independently and
 * still renders the page with an error banner, so the enroll flow's
 * actions can surface the real error on submit.
 *
 * Gated by `FLEET_ENABLED` — the SAME switch the API enforces, so a
 * disabled deployment has no page and no route rather than a page whose
 * every call 404s.
 */
export default async function FleetSettingsPage() {
    if (!isFleetEnabled()) {
        notFound();
    }

    let initialNodes: FleetNodeView[] = [];
    let loadError: string | null = null;
    let initialTokens: FleetEnrollmentTokenView[] = [];
    let tokensError: string | null = null;
    let initialPreferences: FleetExecutionPreferenceView[] = [];
    let preferencesError: string | null = null;
    let initialKillSwitch: FleetKillSwitchState | null = null;
    let killSwitchError: string | null = null;

    // `allSettled`, not `all`: each read fails INDEPENDENTLY and the page
    // still renders with a per-section banner. A routing-preference
    // hiccup must not take down the node list, which is the page's whole
    // reason to exist.
    const [nodesResult, tokensResult, preferencesResult, killSwitchResult] =
        await Promise.allSettled([
            fleetAPI.listNodes(),
            fleetAPI.listOutstandingTokens(),
            fleetAPI.listExecutionPreferences(),
            // Panic controls (EW-778) — the banner's first paint; the
            // client keeps polling it afterwards.
            fleetAPI.killSwitchState(),
        ]);

    if (killSwitchResult.status === 'fulfilled') {
        initialKillSwitch = killSwitchResult.value;
    } else {
        killSwitchError =
            killSwitchResult.reason instanceof Error
                ? killSwitchResult.reason.message
                : 'Failed to read the stop flag';
    }

    if (nodesResult.status === 'fulfilled') {
        initialNodes = nodesResult.value;
    } else {
        loadError =
            nodesResult.reason instanceof Error
                ? nodesResult.reason.message
                : 'Failed to load fleet nodes';
    }

    if (tokensResult.status === 'fulfilled') {
        initialTokens = tokensResult.value;
    } else {
        tokensError =
            tokensResult.reason instanceof Error
                ? tokensResult.reason.message
                : 'Failed to load outstanding enrollment tokens';
    }

    if (preferencesResult.status === 'fulfilled') {
        initialPreferences = preferencesResult.value;
    } else {
        preferencesError =
            preferencesResult.reason instanceof Error
                ? preferencesResult.reason.message
                : 'Failed to load execution preferences';
    }

    const downloads = resolveFleetDownloadUrls();

    return (
        <FleetSettings
            initialNodes={initialNodes}
            loadError={loadError}
            initialTokens={initialTokens}
            tokensError={tokensError}
            apiBaseUrl={resolvePublicApiBaseUrl()}
            desktopDownloadUrl={downloads.desktop}
            nodeDownloadUrl={downloads.node}
            initialPreferences={initialPreferences}
            preferencesError={preferencesError}
            initialKillSwitch={initialKillSwitch}
            killSwitchError={killSwitchError}
        />
    );
}
