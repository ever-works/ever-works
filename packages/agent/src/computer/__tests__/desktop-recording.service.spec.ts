import { decodeDesktopRecordingChunk, FLEET_DESKTOP_RECORDING_MAX_BYTES } from '@ever-works/contracts';
import type { ComputerSession } from '../../entities/computer-session.entity';
import type { ComputerSessionRepository } from '../computer-session.repository';
import { DesktopRecordingService, type DesktopRecordingStoragePort } from '../desktop-recording.service';

/**
 * Desktop view & control (FL-07 P2.C, T-38 … T-40, FR-48 … FR-55) — the
 * recording writer and reader over an in-memory storage plugin: at most one
 * keyframe a second, tiles only after a kept keyframe, chunks with a rewritten
 * index, the caps with their reason, a storage outage that leaves the view
 * alone, expiry from the computer's clamped retention, deletion object-first.
 */

const VIEW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NODE = '33333333-3333-4333-8333-333333333333';
const OWNER = '11111111-1111-4111-8111-111111111111';
const jpegFrame = new TextEncoder().encode('{"kind":"frame"}');
const tiles = new Uint8Array([1, 2, 3, 4]);

function memoryStorage() {
    const objects = new Map<string, Buffer>();
    let next = 0;
    const storage: DesktopRecordingStoragePort & { objects: Map<string, Buffer>; failPuts: boolean; failDeletes: boolean } = {
        providerName: 'memory',
        objects,
        failPuts: false,
        failDeletes: false,
        putObject: jest.fn(async (input: { buffer: Buffer }) => {
            if (storage.failPuts) throw new Error('bucket away');
            const key = `obj-${next++}`;
            objects.set(key, Buffer.from(input.buffer));
            return { key };
        }),
        getObject: jest.fn(async (key: string) => {
            const buffer = objects.get(key);
            if (!buffer) throw new Error('not found');
            return { buffer };
        }),
        deleteObject: jest.fn(async (key: string) => {
            if (storage.failDeletes) throw new Error('bucket away');
            objects.delete(key);
        }),
    };
    return storage;
}

function setup(options: { storage?: boolean; retentionDays?: number } = {}) {
    const row: Partial<ComputerSession> & { id: string } = {
        id: VIEW,
        nodeId: NODE,
        userId: OWNER,
        openedByUserId: OWNER,
        source: 'desktop',
        status: 'live',
        quality: 'smooth',
        controlSpans: [],
        createdAt: new Date('2026-10-27T09:00:00Z'),
    };
    const sessions = {
        findById: jest.fn(async (id: string) => (id === VIEW ? (row as ComputerSession) : null)),
        setRecording: jest.fn(async (_id: string, patch: Partial<ComputerSession>) => {
            Object.assign(row, patch);
        }),
        findDesktopRecordingsForNode: jest.fn(async () => (row.recordingRef ? [row as ComputerSession] : [])),
        findExpiredDesktopRecordings: jest.fn(async (now: Date) =>
            row.recordingRef && row.recordingExpiresAt && row.recordingExpiresAt < now ? [row as ComputerSession] : [],
        ),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const storage = options.storage === false ? null : memoryStorage();
    const service = new DesktopRecordingService(
        sessions as unknown as ComputerSessionRepository,
        { findById: jest.fn(async () => ({ id: NODE, recordingRetentionDays: options.retentionDays ?? 14 })) } as never,
        audit as never,
        storage,
    );
    let clock = Date.parse('2026-10-27T09:00:00Z');
    (service as unknown as { now: () => number }).now = () => clock;
    return {
        service,
        row,
        storage,
        audit,
        advance: (ms: number) => {
            clock += ms;
        },
        start: () =>
            service.start({ viewId: VIEW, nodeId: NODE, ownerUserId: OWNER, actorUserId: OWNER, trigger: 'control' }),
    };
}

const actions = (audit: { tryRecord: jest.Mock }) =>
    audit.tryRecord.mock.calls.map(([input]) => (input as { action: string }).action);

describe('DesktopRecordingService — writing', () => {
    it('keeps at most one keyframe a second and only the tiles that follow a kept one (FR-50)', async () => {
        const { service, storage, advance, start } = setup();
        expect(await start()).toBe(true);
        service.push(VIEW, 23, tiles); // no keyframe yet: dropped
        service.push(VIEW, 20, jpegFrame); // kept
        service.push(VIEW, 23, tiles); // kept
        advance(300);
        service.push(VIEW, 20, jpegFrame); // within the second: dropped …
        service.push(VIEW, 23, tiles); // … and the tiles after it too
        advance(800);
        service.push(VIEW, 20, jpegFrame); // kept
        await service.stop(VIEW, 'view-ended');
        const chunkKey = [...storage!.objects.keys()].find((key) => {
            const bytes = storage!.objects.get(key)!;
            return bytes[0] === 0x45 && bytes[1] === 0x57;
        })!;
        const entries = decodeDesktopRecordingChunk(new Uint8Array(storage!.objects.get(chunkKey)!));
        expect(entries?.map((entry) => [entry.tMs, entry.kind])).toEqual([
            [0, 20],
            [0, 23],
            [1_100, 20],
        ]);
    });

    it('writes a chunk a minute, rewrites the index each time, and stamps the row', async () => {
        const { service, storage, row, advance, start } = setup();
        await start();
        service.push(VIEW, 20, jpegFrame);
        advance(61_000);
        service.push(VIEW, 20, jpegFrame);
        await service.stop(VIEW, 'view-ended');
        expect(row).toMatchObject({ recorded: true, recordingStoppedReason: 'view-ended' });
        const index = JSON.parse(storage!.objects.get(row.recordingRef as string)!.toString('utf8'));
        expect(index.chunks.map((chunk: { seq: number }) => chunk.seq)).toEqual([0, 1]);
        // Only the last index object is kept.
        const indexes = [...storage!.objects.values()].filter((bytes) => bytes.toString('utf8').startsWith('{'));
        expect(indexes).toHaveLength(1);
    });

    it('expires 14 days after the view ends, or the computer’s clamped retention (FR-52)', async () => {
        const fourteen = setup();
        await fourteen.start();
        fourteen.service.push(VIEW, 20, jpegFrame);
        await fourteen.service.stop(VIEW, 'view-ended');
        expect(fourteen.row.recordingExpiresAt?.toISOString()).toBe('2026-11-10T09:00:00.000Z');
        const clamped = setup({ retentionDays: 400 });
        await clamped.start();
        clamped.service.push(VIEW, 20, jpegFrame);
        await clamped.service.stop(VIEW, 'view-ended');
        expect(clamped.row.recordingExpiresAt?.toISOString()).toBe('2027-01-25T09:00:00.000Z');
    });

    it('stops at the size cap with its reason; the view is not touched', async () => {
        const { service, row, start } = setup();
        await start();
        service.push(VIEW, 20, jpegFrame);
        service.push(VIEW, 23, new Uint8Array(FLEET_DESKTOP_RECORDING_MAX_BYTES));
        await new Promise((resolve) => setImmediate(resolve));
        expect(service.isRecording(VIEW)).toBe(false);
        expect(row.recordingStoppedReason).toBe('size-cap');
        expect(row.status).toBe('live');
    });

    it('stops at four hours (time-cap)', async () => {
        const { service, row, advance, start } = setup();
        await start();
        service.push(VIEW, 20, jpegFrame);
        advance(4 * 3_600_000);
        service.push(VIEW, 20, jpegFrame);
        await new Promise((resolve) => setImmediate(resolve));
        expect(row.recordingStoppedReason).toBe('time-cap');
    });

    it('degrades on a storage failure: the recording stops, the row says why (FR-55)', async () => {
        const { service, storage, row, audit, advance, start } = setup();
        await start();
        storage!.failPuts = true;
        service.push(VIEW, 20, jpegFrame);
        advance(61_000);
        service.push(VIEW, 20, jpegFrame);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(service.isRecording(VIEW)).toBe(false);
        expect(row).toMatchObject({ recordingStoppedReason: 'storage-failed', recordingSkippedReason: 'storage-unavailable' });
        expect(actions(audit)).toEqual(['node.desktop.recording.start', 'node.desktop.recording.stop']);
    });

    it('records nothing without a storage plugin, and says so on the row', async () => {
        const { row, start } = setup({ storage: false });
        expect(await start()).toBe(false);
        expect(row.recordingSkippedReason).toBe('storage-unavailable');
    });
});

describe('DesktopRecordingService — reading and deleting', () => {
    it('lists and reads a recording without ever showing a storage key', async () => {
        const { service, start } = setup();
        await start();
        service.push(VIEW, 20, jpegFrame);
        await service.stop(VIEW, 'view-ended');
        const [listed] = await service.list(NODE, 'studio');
        expect(listed).toMatchObject({ viewId: VIEW, nodeName: 'studio', storage: 'memory', stoppedReason: 'view-ended' });
        const read = await service.read(VIEW, NODE, 'studio');
        expect(read?.chunks).toEqual([{ seq: 0, startMs: 0, endMs: 0, bytes: expect.any(Number) }]);
        expect(JSON.stringify(read)).not.toContain('obj-');
        expect(await service.chunk(VIEW, NODE, 0)).not.toBeNull();
        expect(await service.chunk(VIEW, NODE, 9)).toBeNull();
        expect(await service.read(VIEW, 'another-node', 'x')).toBeNull();
    });

    it('deletes object first, row second — a failed delete leaves the row for the next sweep', async () => {
        const { service, storage, row, audit, advance, start } = setup();
        await start();
        service.push(VIEW, 20, jpegFrame);
        await service.stop(VIEW, 'view-ended');
        storage!.failDeletes = true;
        expect(await service.remove(VIEW, OWNER)).toBe(false);
        expect(row.recordingRef).toBeTruthy();
        storage!.failDeletes = false;
        advance(15 * 86_400_000);
        expect(await service.sweepExpired()).toEqual({ deleted: 1, failed: 0 });
        expect(row).toMatchObject({ recordingRef: null, recordingStoppedReason: 'deleted' });
        expect(storage!.objects.size).toBe(0);
        expect(actions(audit)).toContain('node.desktop.recording.delete');
    });

    it('never deletes on read', async () => {
        const { service, storage, start } = setup();
        await start();
        service.push(VIEW, 20, jpegFrame);
        await service.stop(VIEW, 'view-ended');
        const before = storage!.objects.size;
        await service.read(VIEW, NODE, 'studio');
        await service.list(NODE, 'studio');
        expect(storage!.objects.size).toBe(before);
    });
});
