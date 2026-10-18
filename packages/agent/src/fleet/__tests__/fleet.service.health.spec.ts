import { createHash } from 'crypto';
import { hasFleetNodeHealthReading, type FleetNodeHealthStored } from '@ever-works/contracts';
import { FleetNode } from '../../entities/fleet-node.entity';
import { buildDiskLowMarker, buildStoredHealth, FleetService } from '../fleet.service';
import type { FleetNodeHealthService } from '../fleet-node-health.service';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);
const TOKEN = 't'.repeat(43);
const GIB = 1024 ** 3;

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: 'user-1',
        organizationId: null,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        enrollmentTokenHash: sha256(SECRET),
        lastHeartbeatAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'linux/x64',
        version: '1.0.0',
        diskFreeBytes: null,
        minFreeDiskBytes: null,
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        health: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

/**
 * Computer health (FL-03) — the snapshot on the heartbeat path.
 *
 * The properties: the stored snapshot carries the PLATFORM's receipt time,
 * never the machine's (U12); it holds only what the node sent, within bounds
 * (FR-4, FR-30); a beat without one leaves the stored one alone (FR-3, older
 * daemons); and the history writer is called — fire-and-forget, after the
 * row write — only when the history says this beat is to be sampled.
 */
describe('FleetService — computer health on the heartbeat (FL-03)', () => {
    let repository: {
        findById: jest.Mock;
        update: jest.Mock;
        consumeEnrollment: jest.Mock;
        findByCredentialHash: jest.Mock;
    };
    let history: { shouldSample: jest.Mock; record: jest.Mock };

    beforeEach(() => {
        repository = {
            findById: jest.fn(async () => node()),
            update: jest.fn(async () => undefined),
            consumeEnrollment: jest.fn(async () => true),
            findByCredentialHash: jest.fn(async () => null),
        };
        history = { shouldSample: jest.fn(() => false), record: jest.fn() };
    });

    const build = (withHistory = true) =>
        new FleetService(
            repository as never,
            undefined, // pluginRegistry
            undefined, // pluginSettings
            undefined, // inbox
            undefined, // audit
            undefined, // access (FL-01)
            withHistory ? (history as unknown as FleetNodeHealthService) : undefined,
        );

    const patchOf = () => repository.update.mock.calls[0][1] as Partial<FleetNode>;

    it('stores the snapshot stamped with the platform’s receipt time — never the machine’s clock', async () => {
        const before = Date.now();
        const result = await build().heartbeat(NODE_ID, SECRET, {
            health: { cpuPercent: 31.2, memPercent: 58, cpuCores: 4, gpu: null },
        });
        const stored = patchOf().health as FleetNodeHealthStored;
        expect(stored).toMatchObject({ cpuPercent: 31.2, memPercent: 58, cpuCores: 4, gpu: null });
        const at = Date.parse(stored.at);
        expect(at).toBeGreaterThanOrEqual(before);
        expect(stored.at).toBe((patchOf().lastHeartbeatAt as Date).toISOString());
        expect(result?.node.health).toEqual(stored);
    });

    it('stores only known fields within bounds — a value the node did not send is never stored', async () => {
        await build().heartbeat(NODE_ID, SECRET, {
            health: {
                cpuPercent: 250,
                memPercent: 40,
                hostname: 'build-01',
                at: '1999-01-01T00:00:00Z',
            },
        });
        const stored = patchOf().health as FleetNodeHealthStored;
        expect(stored).not.toHaveProperty('cpuPercent');
        expect(stored).not.toHaveProperty('hostname');
        expect(stored.memPercent).toBe(40);
        expect(stored.at).not.toBe('1999-01-01T00:00:00Z');
    });

    it('a beat without a snapshot — or with nothing usable in it — leaves the stored one alone (older daemons)', async () => {
        const previous: FleetNodeHealthStored = { at: '2026-10-18T09:00:00.000Z', cpuPercent: 12 };
        repository.findById.mockResolvedValue(node({ health: previous }));
        await build().heartbeat(NODE_ID, SECRET, { platform: 'linux/x64' });
        expect(patchOf()).not.toHaveProperty('health');

        repository.update.mockClear();
        await build().heartbeat(NODE_ID, SECRET, { health: { hostname: 'x' } });
        expect(patchOf()).not.toHaveProperty('health');
        expect(history.record).not.toHaveBeenCalled();
    });

    it('replaces the snapshot WHOLE: a fact this beat’s probe missed reads "—", not last minute’s value', async () => {
        repository.findById.mockResolvedValue(
            node({ health: { at: '2026-10-18T09:00:00.000Z', cpuPercent: 12, failedServices: 3 } }),
        );
        await build().heartbeat(NODE_ID, SECRET, { health: { cpuPercent: 14 } });
        expect(patchOf().health).not.toHaveProperty('failedServices');
    });

    it('writes a history sample — after the row — only when the history says this beat is sampled', async () => {
        history.shouldSample.mockReturnValue(true);
        await build().heartbeat(NODE_ID, SECRET, { health: { cpuPercent: 31 } });
        const stored = patchOf().health as FleetNodeHealthStored;
        expect(stored.sampledAt).toBe(stored.at);
        expect(history.record).toHaveBeenCalledTimes(1);
        const [nodeId, at, snapshot] = history.record.mock.calls[0];
        expect(nodeId).toBe(NODE_ID);
        expect((at as Date).toISOString()).toBe(stored.at);
        expect(snapshot).toMatchObject({ cpuPercent: 31 });
        expect(repository.update.mock.invocationCallOrder[0]).toBeLessThan(
            history.record.mock.invocationCallOrder[0],
        );
    });

    it('carries the previous sampledAt forward on a beat that is not sampled, so the 55 s floor survives replicas', async () => {
        repository.findById.mockResolvedValue(
            node({
                health: { at: '2026-10-18T09:00:00.000Z', sampledAt: '2026-10-18T09:00:00.000Z' },
            }),
        );
        await build().heartbeat(NODE_ID, SECRET, { health: { cpuPercent: 31 } });
        expect((patchOf().health as FleetNodeHealthStored).sampledAt).toBe(
            '2026-10-18T09:00:00.000Z',
        );
        expect(history.shouldSample).toHaveBeenCalledWith(
            expect.objectContaining({ sampledAt: '2026-10-18T09:00:00.000Z' }),
            expect.any(Date),
        );
        expect(history.record).not.toHaveBeenCalled();
    });

    it('without the history service the snapshot is still stored and nothing is sampled', async () => {
        await build(false).heartbeat(NODE_ID, SECRET, { health: { cpuPercent: 31 } });
        expect(patchOf().health).toMatchObject({ cpuPercent: 31 });
        expect(patchOf().health).not.toHaveProperty('sampledAt');
    });

    it('a history write that throws can never fail the beat', async () => {
        history.shouldSample.mockReturnValue(true);
        history.record.mockImplementation(() => {
            throw new Error('database gone');
        });
        // `record` is contractually non-throwing (its own spec pins that); the
        // heartbeat must not DEPEND on that contract to stay alive.
        const result = await build().heartbeat(NODE_ID, SECRET, { health: { cpuPercent: 31 } });
        expect(result?.node.health).toMatchObject({ cpuPercent: 31 });
        expect(repository.update).toHaveBeenCalledTimes(1);
    });

    it('enrolment stores a snapshot the same way when one arrives (the DTO is shared with the beat)', async () => {
        repository.findByCredentialHash.mockResolvedValue(
            node({
                status: 'enrolling',
                enrollmentTokenHash: sha256(TOKEN),
                credentialIssuedAt: new Date(),
            }),
        );
        const result = await build().enroll(TOKEN, { health: { cpuPercent: 5 } });
        const patch = repository.consumeEnrollment.mock.calls[0][2] as Partial<FleetNode>;
        expect(patch.health).toMatchObject({ cpuPercent: 5 });
        expect(result?.node.health).toMatchObject({ cpuPercent: 5 });
    });

    it('an older daemon (free disk, no snapshot) gets one stable disk-low marker, cleared on recovery and never sampled', async () => {
        history.shouldSample.mockReturnValue(true);
        const lowBeat = { diskFreeBytes: 6 * GIB, minFreeDiskBytes: 5 * GIB };
        await build().heartbeat(NODE_ID, SECRET, lowBeat);
        const marker = patchOf().health as FleetNodeHealthStored;
        expect(Object.keys(marker).sort()).toEqual(['at', 'diskLowSince']);
        expect(marker.diskLowSince).toBe(marker.at);
        expect(hasFleetNodeHealthReading(marker)).toBe(false);
        expect(history.record).not.toHaveBeenCalled();

        // Still low a minute later: the SAME instant, so the item does not move.
        repository.update.mockClear();
        repository.findById.mockResolvedValue(node({ health: marker }));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await build().heartbeat(NODE_ID, SECRET, lowBeat);
        const kept = patchOf().health as FleetNodeHealthStored;
        expect(kept.diskLowSince).toBe(marker.diskLowSince);
        expect(kept.at).not.toBe(marker.at);

        // Recovered: the marker is cleared, not left to say "low" forever.
        repository.update.mockClear();
        repository.findById.mockResolvedValue(node({ health: kept }));
        await build().heartbeat(NODE_ID, SECRET, {
            diskFreeBytes: 60 * GIB,
            minFreeDiskBytes: 5 * GIB,
        });
        expect(patchOf().health).toBeNull();
        expect(history.record).not.toHaveBeenCalled();
    });

    it('serves a row holding junk as "no snapshot", never as one', async () => {
        repository.findById.mockResolvedValue(node({ health: 'garbage' as never }));
        const result = await build().heartbeat(NODE_ID, SECRET, {});
        expect(result?.node.health).toBeNull();
    });
});

describe('buildStoredHealth — the disk-low marker (FR-17)', () => {
    const t0 = new Date('2026-10-18T09:00:00.000Z');
    const t1 = new Date('2026-10-18T09:01:00.000Z');
    const low = { diskFreeBytes: 6 * GIB, minFreeDiskBytes: 5 * GIB };
    const fine = { diskFreeBytes: 60 * GIB, minFreeDiskBytes: 5 * GIB };

    it('marks the first low beat, keeps that instant while it stays low, and drops it when it recovers', () => {
        const first = buildStoredHealth({ diskTotalMiB: 102400 }, t0, null, low);
        expect(first?.diskLowSince).toBe(t0.toISOString());
        const second = buildStoredHealth({ diskTotalMiB: 102400 }, t1, first, low);
        expect(second?.diskLowSince).toBe(t0.toISOString());
        const recovered = buildStoredHealth({ diskTotalMiB: 102400 }, t1, second, fine);
        expect(recovered).not.toHaveProperty('diskLowSince');
    });

    it('reads bigint columns that arrive as strings (Postgres)', () => {
        expect(
            buildStoredHealth({ cpuPercent: 1 }, t0, null, {
                diskFreeBytes: String(6 * GIB),
                minFreeDiskBytes: String(5 * GIB),
            })?.diskLowSince,
        ).toBe(t0.toISOString());
    });

    it('answers null for nothing usable', () => {
        expect(buildStoredHealth(undefined, t0, null, low)).toBeNull();
        expect(buildStoredHealth({ junk: 1 }, t0, null, low)).toBeNull();
    });
});

describe('buildDiskLowMarker — the marker for a beat without a snapshot (FR-17)', () => {
    const t0 = new Date('2026-10-18T09:00:00.000Z');
    const t1 = new Date('2026-10-18T09:01:00.000Z');
    const low = { diskFreeBytes: 6 * GIB, minFreeDiskBytes: 5 * GIB };
    const fine = { diskFreeBytes: 60 * GIB, minFreeDiskBytes: 5 * GIB };

    it('marks, keeps and clears by the floor rule', () => {
        const first = buildDiskLowMarker(t0, null, low);
        expect(first).toEqual({ at: t0.toISOString(), diskLowSince: t0.toISOString() });
        expect(buildDiskLowMarker(t1, first ?? null, low)).toEqual({
            at: t1.toISOString(),
            diskLowSince: t0.toISOString(),
        });
        expect(buildDiskLowMarker(t1, first ?? null, fine)).toBeNull();
        // Nothing stored and nothing low: nothing to write.
        expect(buildDiskLowMarker(t1, null, fine)).toBeUndefined();
    });

    it('never touches a row that holds a real reading — that snapshot carries its own marker', () => {
        const reading: FleetNodeHealthStored = { at: t0.toISOString(), cpuPercent: 12 };
        expect(buildDiskLowMarker(t1, reading, low)).toBeUndefined();
        expect(buildDiskLowMarker(t1, reading, fine)).toBeUndefined();
    });

    it('without a floor there is no rule to judge by (the percentage rule needs the snapshot)', () => {
        expect(
            buildDiskLowMarker(t0, null, { diskFreeBytes: GIB, minFreeDiskBytes: null }),
        ).toBeUndefined();
    });
});
