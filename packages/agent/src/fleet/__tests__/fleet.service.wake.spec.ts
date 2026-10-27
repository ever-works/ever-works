import type { FleetNodeView } from '@ever-works/contracts';
import { saltFleetLanId, withWakeRoutes } from '../fleet.service';

/**
 * Computer health, second phase (FL-03) — the stored network identity and
 * which offline computer of one owner's list can be woken (spec FR-23, FR-24).
 */

const NOW = Date.parse('2026-10-21T10:00:00.000Z');
const WINDOW = 5 * 60_000;

function view(overrides: Partial<FleetNodeView>): FleetNodeView {
    return {
        id: 'node',
        name: 'node',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.4.0',
        capabilities: [],
        lastHeartbeatAt: new Date(NOW - 10_000).toISOString(),
        createdAt: null,
        persisted: true,
        macAddress: null,
        lanId: null,
        canWake: null,
        ...overrides,
    };
}

describe('saltFleetLanId', () => {
    it('is 16 hex characters, stable for one owner, different for another', () => {
        const a = saltFleetLanId('user-1', 'a1b2c3d4e5f60718');
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(saltFleetLanId('user-1', 'a1b2c3d4e5f60718')).toBe(a);
        expect(saltFleetLanId('user-2', 'a1b2c3d4e5f60718')).not.toBe(a);
        expect(a).not.toBe('a1b2c3d4e5f60718');
    });
});

describe('withWakeRoutes', () => {
    const lan = 'feedfacecafebeef';
    const sleeping = view({
        id: 'win-lab',
        name: 'win-lab',
        status: 'offline',
        lastHeartbeatAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
        macAddress: '••:••:••:••:3f:9a',
        lanId: lan,
    });
    const awake = view({
        id: 'build-01',
        name: 'build-01',
        capabilities: ['wake', 'managed'],
        lanId: lan,
    });

    it('names the sibling an asleep computer can be woken through', () => {
        const [target] = withWakeRoutes([sleeping, awake], NOW, WINDOW);
        expect(target!.canWake).toEqual({ nodeId: 'build-01', name: 'build-01' });
    });

    it('offers nothing to an awake computer', () => {
        const [, sibling] = withWakeRoutes([sleeping, awake], NOW, WINDOW);
        expect(sibling!.canWake).toBeNull();
    });

    it('offers nothing without a hardware address or without a sibling advertising wake', () => {
        expect(
            withWakeRoutes([{ ...sleeping, macAddress: null }, awake], NOW, WINDOW)[0]!.canWake,
        ).toBeNull();
        expect(
            withWakeRoutes([sleeping, { ...awake, capabilities: ['managed'] }], NOW, WINDOW)[0]!
                .canWake,
        ).toBeNull();
    });

    it('treats a silent row still marked online as asleep', () => {
        const silent = { ...sleeping, status: 'online' as const };
        expect(withWakeRoutes([silent, awake], NOW, WINDOW)[0]!.canWake).toEqual({
            nodeId: 'build-01',
            name: 'build-01',
        });
    });
});
