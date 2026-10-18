import { describe, expect, it } from 'vitest';
import type { FleetNodeView } from '@ever-works/contracts';
import {
    computerStateKey,
    computerStateTone,
    groupComputersByHost,
    hostNameOf,
    orderComputers,
    readHealthCells,
    relativeTime,
} from './fleet-hub.shared';

/**
 * Fleet hub (FL-01) — the pure rules behind the Overview cards and the
 * Computers table: state words, order, nesting, health cells.
 */

const NOW = new Date('2026-10-18T10:00:00.000Z');

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: over.name ?? 'n',
        name: 'n',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: '2026-10-18T09:59:00.000Z',
        createdAt: null,
        persisted: true,
        ...over,
    }) as FleetNodeView;

describe('computerStateKey (spec §5.8)', () => {
    it.each([
        [{ status: 'enrolling' }, 'enrolling'],
        [{ status: 'disabled' }, 'disabled'],
        [{ status: 'disabled', load: { activeJobCount: 2 } }, 'draining'],
        [{ status: 'paused' }, 'paused'],
        [{ status: 'offline' }, 'offline'],
        [{ status: 'online', workerState: 'quarantined' }, 'quarantined'],
        [{ status: 'online', workerState: 'throttled' }, 'throttled'],
        [
            {
                status: 'online',
                modelThrottles: [
                    {
                        provider: 'claude-code',
                        window: 'weekly',
                        until: 'x',
                        reason: 'r',
                        since: 'y',
                    },
                ],
            },
            'throttled',
        ],
        [{ status: 'online', upgradeRequired: true }, 'upgradeRequired'],
        [{ status: 'online', load: { activeJobCount: 1 } }, 'busy'],
        [{ status: 'online', workerState: 'working' }, 'busy'],
        [{ status: 'online', workerState: 'idle' }, 'online'],
        [{ status: 'exploded' }, 'unknown'],
    ] as Array<[Partial<FleetNodeView>, string]>)('%o is %s', (over, expected) => {
        expect(computerStateKey(node(over))).toBe(expected);
    });

    it('gives every state a tone, offline muted and quarantined danger', () => {
        expect(computerStateTone('online')).toBe('success');
        expect(computerStateTone('offline')).toBe('muted');
        expect(computerStateTone('quarantined')).toBe('danger');
    });
});

describe('orderComputers (FR-7, ACC-FL01-04)', () => {
    it('lists favourites, then online by most recent check, then the rest', () => {
        const ordered = orderComputers([
            node({
                name: 'win-lab',
                status: 'offline',
                lastHeartbeatAt: '2026-10-18T08:00:00.000Z',
            }),
            node({ name: 'build-02', lastHeartbeatAt: '2026-10-18T09:58:00.000Z' }),
            node({ name: 'design-mac', lastHeartbeatAt: '2026-10-18T09:59:30.000Z' }),
            node({ name: 'old-box', status: 'offline', lastHeartbeatAt: null }),
            node({
                name: 'build-01',
                isFavorite: true,
                lastHeartbeatAt: '2026-10-18T09:00:00.000Z',
            }),
        ]);
        expect(ordered.map((entry) => entry.name)).toEqual([
            'build-01',
            'design-mac',
            'build-02',
            'win-lab',
            'old-box',
        ]);
    });

    it('breaks ties by name and does not mutate its input', () => {
        const input = [node({ name: 'b' }), node({ name: 'a' })];
        expect(orderComputers(input).map((entry) => entry.name)).toEqual(['a', 'b']);
        expect(input.map((entry) => entry.name)).toEqual(['b', 'a']);
    });
});

describe('groupComputersByHost (FR-9, ACC-FL01-05)', () => {
    it('nests a VM under its host, even when the VM is stopped', () => {
        const groups = groupComputersByHost([
            node({ id: 'h', name: 'build-01' }),
            node({
                id: 'v',
                name: 'win-11-vm',
                status: 'offline',
                hostNodeId: 'h',
                virtualKind: 'vm',
            }),
            node({ id: 'o', name: 'design-mac' }),
        ]);
        expect(
            groups.map((group) => [group.node.name, group.children.map((child) => child.name)]),
        ).toEqual([
            ['build-01', ['win-11-vm']],
            ['design-mac', []],
        ]);
    });

    it('lists a child on its own when its host is not visible', () => {
        const groups = groupComputersByHost([
            node({ id: 'v', name: 'orphan-vm', hostNodeId: 'gone' }),
        ]);
        expect(groups).toEqual([
            { node: expect.objectContaining({ name: 'orphan-vm' }), children: [] },
        ]);
    });

    it('never drops a computer nested deeper than one level: it is listed on its own, with its host', () => {
        const groups = groupComputersByHost([
            node({ id: 'h', name: 'build-01' }),
            node({ id: 'v', name: 'win-11-vm', hostNodeId: 'h', virtualKind: 'vm' }),
            node({ id: 'c', name: 'redis', hostNodeId: 'v', virtualKind: 'container' }),
        ]);
        expect(
            groups.map((group) => [
                group.node.name,
                group.children.map((child) => child.name),
                group.hostName ?? null,
            ]),
        ).toEqual([
            ['build-01', ['win-11-vm'], null],
            ['redis', [], 'win-11-vm'],
        ]);
    });

    it('never drops computers caught in a host cycle', () => {
        const groups = groupComputersByHost([
            node({ id: 'a', name: 'alpha', hostNodeId: 'b' }),
            node({ id: 'b', name: 'beta', hostNodeId: 'a' }),
        ]);
        expect(groups.map((group) => [group.node.name, group.children.length])).toEqual([
            ['alpha', 0],
            ['beta', 0],
        ]);
    });

    it('names the host for the subtitle', () => {
        const nodes = [node({ id: 'h', name: 'build-01' })];
        expect(hostNameOf({ hostNodeId: 'h' }, nodes)).toBe('build-01');
        expect(hostNameOf({ hostNodeId: null }, nodes)).toBeNull();
    });
});

describe('readHealthCells (FR-8, FR-38)', () => {
    it('answers null — the card shows "—" — when no snapshot exists', () => {
        expect(readHealthCells(node())).toBeNull();
        expect(readHealthCells({ ...node(), health: { note: 'nothing numeric' } })).toBeNull();
    });

    it('reads the three numbers, clamped and rounded', () => {
        expect(
            readHealthCells({
                ...node(),
                health: {
                    cpuPercent: 31.4,
                    memPercent: 120,
                    diskPercent: 40,
                    at: '2026-10-18T09:59:00.000Z',
                },
            }),
        ).toEqual({
            cpuPercent: 31,
            memPercent: 100,
            diskPercent: 40,
            at: '2026-10-18T09:59:00.000Z',
            stale: false,
        });
    });

    it('marks a snapshot older than the last check as stale, never hides that', () => {
        const cells = readHealthCells({
            ...node({ lastHeartbeatAt: '2026-10-18T09:59:00.000Z' }),
            health: { cpuPercent: 10, at: '2026-10-18T09:00:00.000Z' },
        });
        expect(cells?.stale).toBe(true);
        expect(readHealthCells({ ...node(), health: { cpuPercent: 10 } })?.stale).toBe(true);
    });
});

describe('relativeTime', () => {
    it('reads minutes, hours and days, and null for no instant', () => {
        expect(relativeTime('2026-10-18T08:00:00.000Z', NOW, 'en')).toBe('2 hours ago');
        expect(relativeTime('2026-10-18T09:59:40.000Z', NOW, 'en')).toBe('this minute');
        expect(relativeTime('2026-10-15T10:00:00.000Z', NOW, 'en')).toBe('3 days ago');
        expect(relativeTime(null, NOW, 'en')).toBeNull();
        expect(relativeTime('nope', NOW, 'en')).toBeNull();
    });
});
