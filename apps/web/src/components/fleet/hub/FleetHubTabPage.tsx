import '../modules/server';
import { fleetAPI, type FleetNodeView } from '@/lib/api/fleet';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import {
    FLEET_FEATURE_FLAGS,
    FLEET_HUB_TABS,
    resolveHubTab,
    type FleetHubTabId,
} from '../registry';
import { FleetTelemetryOnMount } from '../FleetTelemetryOnMount';
import { FleetHubFrame } from './FleetHubFrame';
import { FleetHubTabPlaceholder } from './FleetHubTabPlaceholder';

type RegistryTab = Exclude<FleetHubTabId, 'overview' | 'computers'>;

/**
 * Fleet hub (FL-01, FR-3, FR-4) — a hub tab filled through the registry
 * (Sessions · Checkouts · Commands · Usage). FL-01 owns the route (CONTRACTS
 * §11.1); the tab's epic registers its panel with `registerHubTab` and this
 * page renders it — loaded only on this route — or, until then, the honest
 * placeholder naming the epic ("switched off on this deployment" when the epic
 * shipped behind a flag that is off here).
 */
export async function FleetHubTabPage({ tab }: { tab: RegistryTab }) {
    const flags = readFleetFeatureFlags(FLEET_FEATURE_FLAGS);
    const state = resolveHubTab(tab, { flags });
    const slot = FLEET_HUB_TABS.find((entry) => entry.id === tab);

    let body;
    if (state.kind === 'ready') {
        const { default: Panel } = await state.load();
        const nodes: FleetNodeView[] = await fleetAPI.listVisibleNodes().catch(() => []);
        body = <Panel nodes={nodes} flags={flags} />;
    } else {
        body = (
            <FleetHubTabPlaceholder
                tab={tab}
                epic={
                    state.kind === 'not-shipped' || state.kind === 'switched-off'
                        ? state.epic
                        : (slot?.epic ?? '')
                }
                switchedOff={state.kind === 'switched-off'}
            />
        );
    }

    return (
        <FleetHubFrame active={tab}>
            <FleetTelemetryOnMount event={{ name: 'fleet_hub_opened', properties: { tab } }} />
            {body}
        </FleetHubFrame>
    );
}
