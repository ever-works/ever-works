import {
    compareFleetServices,
    fleetServiceMatchesFind,
    type FleetServiceAction,
    type FleetServiceView,
} from '@ever-works/contracts';

/**
 * Services tab (FL-09 P1, spec §5.1) — the pure part: ordering, find, which
 * buttons a row shows, and its marker. The node already ordered the list
 * (FR-2); the page re-applies the same contracts comparator after a local
 * find so the order can never drift between the two.
 */

/** Failed first, then running, then the rest, filtered by the find field. */
export function visibleServices(
    services: readonly FleetServiceView[],
    find: string,
): FleetServiceView[] {
    return services
        .filter((service) => fleetServiceMatchesFind(service, find))
        .sort(compareFleetServices);
}

/** The buttons in the row itself (spec §5.1): Start when not running; Restart and Stop while running. */
export function primaryActions(service: FleetServiceView): FleetServiceAction[] {
    const running = service.state === 'running' || service.state === 'activating';
    const wanted: FleetServiceAction[] = running ? ['restart', 'stop'] : ['start'];
    return wanted.filter((action) => service.actions.includes(action));
}

/** The At boot toggle's act, when the manager supports it for this row. */
export function atBootAction(service: FleetServiceView): FleetServiceAction | null {
    if (service.atBoot === true && service.actions.includes('disable')) return 'disable';
    if (service.atBoot !== true && service.actions.includes('enable')) return 'enable';
    return null;
}

/** The `⚠` marker of a row: the node itself, or the kind of thing stopping it could cut off. */
export function riskMarker(
    service: FleetServiceView,
): 'node' | 'network' | 'ssh' | 'vpn' | 'docker' | null {
    if (service.isNode) return 'node';
    return service.blastRadius?.kind ?? null;
}

/** The glyph a state shows (spec §5.1): ▲ failed, ● running, ○ the rest. */
export function stateGlyph(service: FleetServiceView): '▲' | '●' | '○' {
    if (service.state === 'failed') return '▲';
    if (
        service.state === 'running' ||
        service.state === 'activating' ||
        service.state === 'deactivating'
    )
        return '●';
    return '○';
}

/** Counts for the header: all, and failed. */
export function serviceCounts(services: readonly FleetServiceView[]): {
    total: number;
    failed: number;
} {
    return {
        total: services.length,
        failed: services.filter((service) => service.state === 'failed').length,
    };
}
