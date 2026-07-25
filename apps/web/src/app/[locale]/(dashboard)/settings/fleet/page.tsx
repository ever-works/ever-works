import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { fleetAPI, type FleetNodeView } from '@/lib/api/fleet';
import { FleetSettings } from '@/components/settings/FleetSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.fleet');
    return { title: t('title') };
}

/**
 * Fleet (Wave 12, slice 1) — settings page for the node registry:
 * where the user's work CAN run (Job Runtime, directly below in the
 * menu, stays HOW work is dispatched).
 *
 * Server component: fetches the merged node list (enrolled machines +
 * live nodes of the user's own configured clusters, tagged `k8s`) and
 * hands it to the client component. Graceful degradation: a hard fetch
 * failure still renders the page with an empty list + error banner so
 * the enroll flow's actions can surface the real error on submit.
 */
export default async function FleetSettingsPage() {
    let initialNodes: FleetNodeView[] = [];
    let loadError: string | null = null;

    try {
        initialNodes = await fleetAPI.listNodes();
    } catch (error) {
        loadError = error instanceof Error ? error.message : 'Failed to load fleet nodes';
    }

    return <FleetSettings initialNodes={initialNodes} loadError={loadError} />;
}
