import '@/components/fleet/modules/server';
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { fleetAPI, type FleetNodeDetailView } from '@/lib/api/fleet';
import { ApiResponseError } from '@/lib/api/server-api';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import {
    FLEET_FEATURE_FLAGS,
    resolveComputerTab,
    resolveComputerTabId,
} from '@/components/fleet/registry';
import { readNodeConsents } from '@/components/fleet/fleet-consents.shared';
import { ComputerHeader } from '@/components/fleet/computer/ComputerHeader';
import { ComputerTabs } from '@/components/fleet/computer/ComputerTabs';
import { ComputerTabPlaceholder } from '@/components/fleet/computer/ComputerTabPlaceholder';
import { FleetTelemetryOnMount } from '@/components/fleet/FleetTelemetryOnMount';

/**
 * One read of the computer, or null when the caller may not see it (404,
 * identical to unknown). Cached for the render, so the title and the page
 * share one read.
 */
const loadComputer = cache(async (id: string): Promise<FleetNodeDetailView | null> => {
    try {
        return await fleetAPI.nodeDetail(id);
    } catch (error) {
        if (
            error instanceof ApiResponseError &&
            (error.statusCode === 404 || error.statusCode === 400)
        ) {
            return null;
        }
        throw error;
    }
});

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string }>;
}): Promise<Metadata> {
    const { id } = await params;
    const t = await getTranslations('fleet.hub');
    const detail = await loadComputer(id).catch(() => null);
    return { title: detail ? `${detail.node.name} · ${t('title')}` : t('title') };
}

/**
 * Fleet hub (FL-01, FR-16 – FR-21, spec §5.8 / §5.9) — `/fleet/computers/[id]`,
 * one computer's page: its header, its twelve tabs (`?tab=`, Overview by
 * default) and the selected tab's panel. A tab its epic registered is loaded
 * only when selected (FR-18); any other tab renders the placeholder naming
 * the epic, the switched-off flag, the missing consent with the exact command,
 * or "not available on this kind of computer yet" (U4 – U6).
 *
 * A computer the caller may not see answers the same 404 as one that does not
 * exist (FR-30), as does a computer removed while its page was open (U10).
 */
export default async function FleetComputerPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ tab?: string | string[] }>;
}) {
    const [{ id }, { tab: rawTab }] = await Promise.all([params, searchParams]);
    const detail = await loadComputer(id);
    if (!detail || !detail.node.persisted) notFound();
    const node = detail.node;
    const tab = resolveComputerTabId(rawTab);
    const flags = readFleetFeatureFlags(FLEET_FEATURE_FLAGS);
    const state = resolveComputerTab(tab, { flags, node, consents: readNodeConsents(node) });

    let panel;
    if (state.kind === 'ready') {
        const { default: Panel } = await state.load();
        panel = <Panel node={node} flags={flags} />;
    } else {
        panel = <ComputerTabPlaceholder tab={tab} nodeName={node.name} state={state} />;
    }

    return (
        <div className="w-full" data-testid="fleet-computer-page" data-tab={tab}>
            <FleetTelemetryOnMount event={{ name: 'fleet_computer_opened', properties: { tab } }} />
            <ComputerHeader node={node} flags={flags} />
            <ComputerTabs nodeId={node.id} active={tab} />
            <div
                id="fleet-computer-panel"
                role="tabpanel"
                aria-labelledby={`fleet-computer-tab-${tab}`}
            >
                {panel}
            </div>
        </div>
    );
}
