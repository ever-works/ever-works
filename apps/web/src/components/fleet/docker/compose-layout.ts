import type { FleetComposeServiceView } from '@ever-works/contracts';

/**
 * Compose picture (FL-09 P3, plan §3, spec FR-33) — a deterministic layered
 * layout of a project's services by `depends_on`, drawn as SVG without a
 * graph library:
 *
 *  - **layers** by longest path over `depends_on`; drawn as the spec does, a
 *    service sits LEFT of everything it depends on, so every arrow points
 *    right (`api ──▶ db`);
 *  - **order** inside a layer by the barycentre of what it depends on
 *    (ties by name), one pass — stable for the same input;
 *  - **cycles** (Compose refuses them, but a description may still carry
 *    one) are broken by ignoring the edge that closes the cycle.
 *
 * Edge colour (FR-33): amber while a `service_healthy` dependency is not yet
 * healthy, red when the dependency is down, grey otherwise.
 */

export interface LayoutBox {
    name: string;
    layer: number;
    row: number;
    x: number;
    y: number;
}

export interface LayoutEdge {
    from: string;
    to: string;
    tone: 'grey' | 'amber' | 'red';
    condition: string;
}

export interface ComposeLayout {
    boxes: LayoutBox[];
    edges: LayoutEdge[];
    width: number;
    height: number;
}

export const BOX_WIDTH = 220;
export const BOX_HEIGHT = 112;
const GAP_X = 72;
const GAP_Y = 28;

/** Layer of every service (longest path over `depends_on`), cycle-safe. */
export function composeLayers(services: readonly Pick<FleetComposeServiceView, 'name' | 'dependsOn'>[]): Map<string, number> {
    const names = new Set(services.map((service) => service.name));
    const deps = new Map(
        services.map((service) => [service.name, service.dependsOn.map((dep) => dep.service).filter((dep) => names.has(dep))]),
    );
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const visit = (name: string): number => {
        const known = layer.get(name);
        if (known !== undefined) return known;
        if (visiting.has(name)) return 0; // the edge that closes a cycle is ignored
        visiting.add(name);
        let value = 0;
        for (const dep of deps.get(name) ?? []) value = Math.max(value, visit(dep) + 1);
        visiting.delete(name);
        layer.set(name, value);
        return value;
    };
    for (const name of [...names].sort()) visit(name);
    return layer;
}

/** The colour of the arrow `from → to` (FR-33). */
export function edgeTone(
    dependency: Pick<FleetComposeServiceView, 'state' | 'health'> | undefined,
    condition: string,
): LayoutEdge['tone'] {
    if (!dependency || dependency.state === 'absent' || dependency.state === 'exited' || dependency.state === 'dead') {
        return 'red';
    }
    if (condition === 'service_healthy' && dependency.health !== 'healthy') return 'amber';
    return 'grey';
}

export function layoutCompose(services: readonly FleetComposeServiceView[]): ComposeLayout {
    const layers = composeLayers(services);
    const byLayer = new Map<number, string[]>();
    for (const service of [...services].sort((a, b) => a.name.localeCompare(b.name))) {
        const value = layers.get(service.name) ?? 0;
        byLayer.set(value, [...(byLayer.get(value) ?? []), service.name]);
    }
    const rowOf = new Map<string, number>();
    const depsOf = new Map(services.map((service) => [service.name, service.dependsOn.map((dep) => dep.service)]));
    for (const value of [...byLayer.keys()].sort((a, b) => a - b)) {
        const names = byLayer.get(value) ?? [];
        const barycentre = (name: string): number => {
            const placed = (depsOf.get(name) ?? []).map((dep) => rowOf.get(dep)).filter((row): row is number => row !== undefined);
            return placed.length > 0 ? placed.reduce((sum, row) => sum + row, 0) / placed.length : Number.POSITIVE_INFINITY;
        };
        const ordered = [...names].sort((a, b) => {
            const delta = barycentre(a) - barycentre(b);
            return Number.isFinite(delta) && delta !== 0 ? delta : a.localeCompare(b);
        });
        ordered.forEach((name, row) => rowOf.set(name, row));
    }
    const maxLayerOf = Math.max(0, ...services.map((service) => layers.get(service.name) ?? 0));
    // As the spec draws it: a service LEFT of what it depends on, arrows pointing right (api ──▶ db).
    const boxes: LayoutBox[] = services
        .map((service) => {
            const layer = layers.get(service.name) ?? 0;
            const row = rowOf.get(service.name) ?? 0;
            return {
                name: service.name,
                layer,
                row,
                x: (maxLayerOf - layer) * (BOX_WIDTH + GAP_X),
                y: row * (BOX_HEIGHT + GAP_Y),
            };
        })
        .sort((a, b) => a.x - b.x || a.row - b.row);
    const byName = new Map(services.map((service) => [service.name, service]));
    const edges: LayoutEdge[] = [];
    for (const service of services) {
        for (const dep of service.dependsOn) {
            if (!byName.has(dep.service)) continue;
            edges.push({ from: service.name, to: dep.service, tone: edgeTone(byName.get(dep.service), dep.condition), condition: dep.condition });
        }
    }
    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const maxLayer = Math.max(0, ...boxes.map((box) => box.layer));
    const maxRow = Math.max(0, ...boxes.map((box) => box.row));
    return {
        boxes,
        edges,
        width: (maxLayer + 1) * BOX_WIDTH + maxLayer * GAP_X,
        height: (maxRow + 1) * BOX_HEIGHT + maxRow * GAP_Y,
    };
}
