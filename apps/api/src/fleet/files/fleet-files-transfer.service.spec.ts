import {
    FLEET_FILES_LIMITS,
    FLEET_LINK_FRAME_KINDS,
    decodeFleetLinkAck,
    encodeFleetFilesBytesRecord,
    encodeFleetFilesHeaderRecord,
    encodeFleetLinkAck,
    type FleetLinkFrameKind,
} from '@ever-works/contracts';
import type { FleetLinkChannelEvents } from '../../fleet-link/fleet-link-channel';
import { FleetLinkException } from '../../fleet-link/fleet-link.errors';
import {
    FleetFilesTransferService,
    type FleetFilesDownloadSink,
} from './fleet-files-transfer.service';
import { FleetFilesService } from './fleet-files.service';

/**
 * Files on computers (FL-11, T-09) — the transfer bridge against a fake link:
 * a raw download, a zip, credit returned only after the response drains, the
 * Agent credential refusal, the per-computer limit, and an upload re-framed
 * into records under the machine's credit. Written, not run (fast-build rule).
 */

const NODE = { id: '11111111-1111-4111-8111-111111111111', userId: 'owner-1', name: 'build-01' };
const ROOT = 'abcdef0123456789';

function fakeChannel(onRequest: (type: string, params: Record<string, unknown>) => unknown) {
    const sent: Array<{ kind: FleetLinkFrameKind; payload: Uint8Array }> = [];
    let events: FleetLinkChannelEvents = {};
    const channel = {
        nodeId: NODE.id,
        channel: 3,
        family: 'files',
        isOpen: true,
        isClosed: false,
        linkGeneration: 1,
        closedWith: null as null | { reason: string; hint?: string },
        request: jest.fn(async (type: string, params: Record<string, unknown>) => ({
            requestId: 'r-1',
            ...(onRequest(type, params) as object),
        })),
        sendJson: jest.fn(() => true),
        sendBinary: jest.fn((kind: FleetLinkFrameKind, payload: Uint8Array) => {
            sent.push({ kind, payload });
            return true;
        }),
        close: jest.fn((reason = 'normal', hint?: string) => {
            channel.isClosed = true;
            channel.closedWith = { reason, ...(hint ? { hint } : {}) };
        }),
        listen: jest.fn(),
    };
    return {
        channel,
        sent,
        bind(next: FleetLinkChannelEvents) {
            events = next;
        },
        emit: {
            binary: (kind: FleetLinkFrameKind, payload: Uint8Array) =>
                events.binary?.(kind, payload),
            json: (message: Record<string, unknown>) => events.json?.(message),
            close: (reason: string, hint?: string) => events.close?.(reason as never, hint),
        },
    };
}

function service(fake: ReturnType<typeof fakeChannel>) {
    const link = {
        openChannel: jest.fn(async (input: { events?: FleetLinkChannelEvents }) => {
            fake.bind(input.events ?? {});
            return fake.channel;
        }),
    };
    const files = { record: jest.fn(async () => undefined) } as unknown as FleetFilesService;
    const fleet = { getVisibleForUser: jest.fn(async () => ({ view: {}, role: 'owner' })) };
    const nodes = { findById: jest.fn(async () => NODE) };
    const operations = { track: jest.fn(), requestCancel: jest.fn() };
    const transfers = new FleetFilesTransferService(
        files,
        fleet as never,
        nodes as never,
        link as never,
        operations as never,
    );
    return { transfers, link, files, operations };
}

function sink() {
    const chunks: Buffer[] = [];
    const drains: Array<() => void> = [];
    const state = {
        full: false,
        ended: false,
        destroyed: false,
        headers: {} as Record<string, string>,
    };
    let started = false;
    const value: FleetFilesDownloadSink & { chunks: Buffer[]; drain(): void; state: typeof state } =
        {
            start(headers) {
                started = true;
                state.headers = headers;
            },
            write(chunk) {
                chunks.push(Buffer.from(chunk));
                return !state.full;
            },
            onDrain(listener) {
                drains.push(listener);
            },
            end() {
                state.ended = true;
            },
            destroy() {
                state.destroyed = true;
            },
            onClose() {
                // the browser stays
            },
            get started() {
                return started;
            },
            chunks,
            drain() {
                state.full = false;
                for (const listener of drains.splice(0)) listener();
            },
            state,
        };
    return value;
}

const header = (path: string, size: number) =>
    encodeFleetFilesHeaderRecord({ path, kind: 'file', size, mode: 0o644, mtimeMs: 0 })!;
const bytes = (text: string) => encodeFleetFilesBytesRecord(Buffer.from(text))!;

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('FleetFilesTransferService — download', () => {
    it('streams one file as itself with its length, and acks each frame', async () => {
        const fake = fakeChannel(() => ({
            result: {
                operationId: 'op-1',
                accepted: { entries: 1, bytes: 5, single: true, name: 'a.log' },
            },
        }));
        const { transfers, operations } = service(fake);
        const out = sink();
        const done = transfers.download(
            { kind: 'user', userId: 'owner-1' },
            NODE.id,
            { root: ROOT, path: 'logs', entries: ['a.log'] },
            out,
        );
        await settle();
        expect(out.state.headers['Content-Length']).toBe('5');
        expect(out.state.headers['Content-Disposition']).toContain('a.log');
        expect(operations.track).toHaveBeenCalledWith(
            expect.objectContaining({ operationId: 'op-1', family: 'files' }),
        );
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, header('a.log', 5));
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, bytes('hello'));
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
        await done;
        expect(Buffer.concat(out.chunks).toString()).toBe('hello');
        expect(out.state.ended).toBe(true);
        expect(fake.sent.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.ACK)).toHaveLength(
            2,
        );
    });

    it('holds credit until the response drains (FR-10: never more than the window)', async () => {
        const fake = fakeChannel(() => ({
            result: {
                operationId: 'op-1',
                accepted: { entries: 1, bytes: 5, single: true, name: 'a.log' },
            },
        }));
        const { transfers } = service(fake);
        const out = sink();
        out.state.full = true;
        void transfers.download(
            { kind: 'user', userId: 'owner-1' },
            NODE.id,
            { root: ROOT, entries: ['a.log'] },
            out,
        );
        await settle();
        // The sink reports a full response only through `write`'s return value (its contract), so
        // the frame must carry bytes for the response to refuse. A header-only frame writes nothing
        // in raw mode and buffers nothing on the platform, so holding its credit protects no window
        // (this case, written unrun in bbd7b4172, sent one and so could never pass).
        const payload = Buffer.concat([header('a.log', 5), bytes('hello')]);
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, payload);
        expect(Buffer.concat(out.chunks).toString()).toBe('hello');
        expect(fake.sent.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.ACK)).toHaveLength(
            0,
        );
        out.drain();
        const acks = fake.sent.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.ACK);
        expect(acks).toHaveLength(1);
        expect(decodeFleetLinkAck(acks[0].payload)).toBe(payload.byteLength);
    });

    it('builds a zip for several entries', async () => {
        const fake = fakeChannel(() => ({
            result: { operationId: 'op-1', accepted: { entries: 2, bytes: 2, single: false } },
        }));
        const { transfers } = service(fake);
        const out = sink();
        const done = transfers.download(
            { kind: 'user', userId: 'owner-1' },
            NODE.id,
            { root: ROOT, path: 'src', entries: ['a', 'b'] },
            out,
        );
        await settle();
        expect(out.state.headers['Content-Type']).toBe('application/zip');
        expect(out.state.headers['Content-Disposition']).toContain('src.zip');
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, header('a', 1));
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, bytes('1'));
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, header('b', 1));
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, bytes('2'));
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
        await done;
        const archive = Buffer.concat(out.chunks);
        expect(archive.readUInt32LE(0)).toBe(0x04034b50);
        expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
    });

    it('refuses an Agent a credential-shaped file, with no override (FR-17, U13)', async () => {
        const fake = fakeChannel(() => ({
            error: {
                code: 'confirmation_required',
                hint: 'x',
                details: { class: 'confirm', credentialShaped: ['.env'] },
            },
        }));
        const { transfers } = service(fake);
        await expect(
            transfers.download(
                { kind: 'agent', agentId: 'agent-1', ownerUserId: 'owner-1' },
                NODE.id,
                { root: ROOT, entries: ['.env'], confirm: true },
                sink(),
            ),
        ).rejects.toMatchObject({ linkError: { code: 'permission_denied' } });
        expect(fake.channel.request).toHaveBeenCalledWith(
            'files.pack',
            expect.objectContaining({ allowCredentialShaped: false }),
            expect.anything(),
        );
    });

    it('asks a person to confirm, naming the file', async () => {
        const fake = fakeChannel(() => ({
            error: {
                code: 'confirmation_required',
                hint: 'x',
                details: { class: 'confirm', credentialShaped: ['.env'] },
            },
        }));
        const { transfers } = service(fake);
        const refusal = await transfers
            .download(
                { kind: 'user', userId: 'owner-1' },
                NODE.id,
                { root: ROOT, entries: ['.env'] },
                sink(),
            )
            .catch((error: FleetLinkException) => error);
        expect(refusal).toBeInstanceOf(FleetLinkException);
        expect((refusal as FleetLinkException).linkError).toMatchObject({
            code: 'confirmation_required',
            details: { class: 'confirm' },
        });
        expect((refusal as FleetLinkException).linkError.hint).toContain('.env');
    });

    it('aborts the response when the computer goes away mid-transfer (U7)', async () => {
        const fake = fakeChannel(() => ({
            result: {
                operationId: 'op-1',
                accepted: { entries: 1, bytes: 10, single: true, name: 'a.log' },
            },
        }));
        const { transfers } = service(fake);
        const out = sink();
        const done = transfers.download(
            { kind: 'user', userId: 'owner-1' },
            NODE.id,
            { root: ROOT, entries: ['a.log'] },
            out,
        );
        await settle();
        fake.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, header('a.log', 10));
        fake.emit.close('resume_failed', 'the link dropped');
        await done;
        expect(out.state.destroyed).toBe(true);
        const list = await transfers.transfersForUser('owner-1', NODE.id);
        expect(list.transfers[0]).toMatchObject({ state: 'interrupted' });
    });

    it('refuses a third transfer on one computer (CONTRACTS §10)', async () => {
        const fake = fakeChannel(() => ({
            result: {
                operationId: 'op-1',
                accepted: { entries: 1, bytes: 10, single: true, name: 'a.log' },
            },
        }));
        const { transfers } = service(fake);
        const start = () =>
            transfers.download(
                { kind: 'user', userId: 'owner-1' },
                NODE.id,
                { root: ROOT, entries: ['a.log'] },
                sink(),
            );
        void start();
        void start();
        await settle();
        await expect(start()).rejects.toMatchObject({ linkError: { code: 'limit_exceeded' } });
    });
});

describe('FleetFilesTransferService — upload', () => {
    async function* body(parts: Uint8Array[]) {
        for (const part of parts) yield part;
    }

    it('re-frames the body into whole records, waits for credit, then END', async () => {
        const fake = fakeChannel((type) =>
            type === 'files.unpack'
                ? { result: { operationId: 'op-2', accepted: true } }
                : { result: null },
        );
        const { transfers } = service(fake);
        const stream = Buffer.concat([header('a.txt', 5), bytes('hello')]);
        // Split mid-record: the bridge must reassemble.
        const upload = transfers.upload(
            { kind: 'user', userId: 'owner-1' },
            NODE.id,
            { root: ROOT, path: 'src', expectedEntries: 1, expectedBytes: 5 },
            body([stream.subarray(0, 7), stream.subarray(7)]),
        );
        for (
            let i = 0;
            i < 50 && !fake.sent.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.END);
            i += 1
        ) {
            await settle();
        }
        const data = fake.sent.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA);
        expect(data).toHaveLength(2);
        expect(Buffer.from(data[0].payload)).toEqual(Buffer.from(header('a.txt', 5)));
        fake.emit.json({
            type: 'files.unpacked',
            operationId: 'op-2',
            entries: 1,
            bytes: 5,
            replaced: 0,
            skipped: 0,
        });
        await expect(upload).resolves.toMatchObject({ entries: 1, bytes: 5, operationId: 'op-2' });
    });

    it('refuses more than 2 GiB before opening anything (FR-16)', async () => {
        const fake = fakeChannel(() => ({ result: null }));
        const { transfers, link } = service(fake);
        await expect(
            transfers.upload(
                { kind: 'user', userId: 'owner-1' },
                NODE.id,
                { root: ROOT, expectedBytes: FLEET_FILES_LIMITS.maxOpBytes + 1 },
                body([]),
            ),
        ).rejects.toMatchObject({ linkError: { code: 'limit_exceeded' } });
        expect(link.openChannel).not.toHaveBeenCalled();
    });

    it('refuses a stream path that leaves the folder, and closes the channel', async () => {
        const fake = fakeChannel(() => ({ result: { operationId: 'op-2', accepted: true } }));
        const { transfers } = service(fake);
        const json = Buffer.from(JSON.stringify({ path: '../x', kind: 'file', size: 0 }));
        const record = Buffer.alloc(5 + json.length);
        record.writeUInt8(0x48, 0);
        record.writeUInt32BE(json.length, 1);
        json.copy(record, 5);
        await expect(
            transfers.upload(
                { kind: 'user', userId: 'owner-1' },
                NODE.id,
                { root: ROOT },
                body([record]),
            ),
        ).rejects.toMatchObject({ linkError: { code: 'invalid' } });
        expect(fake.channel.close).toHaveBeenCalled();
    });

    it('waits for the machine to return credit before sending past the window', async () => {
        const fake = fakeChannel(() => ({ result: { operationId: 'op-2', accepted: true } }));
        const { transfers } = service(fake);
        const big = Buffer.alloc(FLEET_FILES_LIMITS.chunkBytes - 5, 1);
        const count = Math.ceil(FLEET_FILES_LIMITS.windowBytes / big.length) + 4;
        const parts: Uint8Array[] = [header('big.bin', big.length * count)];
        for (let i = 0; i < count; i += 1) parts.push(encodeFleetFilesBytesRecord(big)!);
        void transfers
            .upload({ kind: 'user', userId: 'owner-1' }, NODE.id, { root: ROOT }, body(parts))
            .catch(() => undefined);
        for (let i = 0; i < 200; i += 1) await settle();
        const sentBytes = fake.sent
            .filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA)
            .reduce((sum, frame) => sum + frame.payload.byteLength, 0);
        expect(sentBytes).toBeLessThanOrEqual(FLEET_FILES_LIMITS.windowBytes);
        fake.emit.binary(
            FLEET_LINK_FRAME_KINDS.ACK,
            encodeFleetLinkAck(FLEET_FILES_LIMITS.windowBytes)!,
        );
        for (let i = 0; i < 200; i += 1) await settle();
        const after = fake.sent
            .filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA)
            .reduce((sum, frame) => sum + frame.payload.byteLength, 0);
        expect(after).toBeGreaterThan(sentBytes);
    });
});

describe('FleetFilesTransferService — copy (P2, FR-24…FR-29)', () => {
    const DEST = '33333333-3333-4333-8333-333333333333';

    function copySetup(options: { credential?: boolean } = {}) {
        const source = fakeChannel((type, params) =>
            params.dryRun === true
                ? {
                      result: {
                          accepted: { entries: 1, bytes: 5, single: true },
                          credentialShaped: options.credential ? ['.env'] : [],
                          credentialShapedCount: options.credential ? 1 : 0,
                      },
                  }
                : { result: { operationId: 'op-a', accepted: { entries: 1, bytes: 5 } } },
        );
        const destination = fakeChannel(() => ({
            result: { operationId: 'op-b', accepted: true },
        }));
        let opened = 0;
        const link = {
            openChannel: jest.fn(
                async (input: { nodeId: string; events?: FleetLinkChannelEvents }) => {
                    opened += 1;
                    const target = opened === 1 ? source : destination;
                    target.bind(input.events ?? {});
                    return target.channel;
                },
            ),
        };
        const files = { record: jest.fn(async () => undefined) } as unknown as FleetFilesService;
        const nodes = {
            findById: jest.fn(async (id: string) =>
                id === DEST ? { id: DEST, userId: 'owner-1', name: 'build-02' } : NODE,
            ),
        };
        const transfers = new FleetFilesTransferService(
            files,
            { getVisibleForUser: jest.fn(async () => ({ view: {}, role: 'owner' })) } as never,
            nodes as never,
            link as never,
            { track: jest.fn(), requestCancel: jest.fn() } as never,
        );
        return { transfers, source, destination, link, files };
    }

    const input = {
        root: ROOT,
        path: 'dist',
        entries: ['app.js'],
        to: { nodeId: DEST, root: ROOT, path: '' },
    };

    it('refuses the same folder before anything opens (U10)', async () => {
        const { transfers, link } = copySetup();
        await expect(
            transfers.copy({ kind: 'user', userId: 'owner-1' }, NODE.id, {
                ...input,
                to: { nodeId: NODE.id, root: ROOT, path: 'dist' },
            }),
        ).rejects.toMatchObject({
            linkError: { code: 'invalid', hint: 'Source and destination are the same folder' },
        });
        expect(link.openChannel).not.toHaveBeenCalled();
    });

    it('forwards the source frames unchanged and the destination credit back (FR-24, FR-25)', async () => {
        const { transfers, source, destination, files } = copySetup();
        await expect(
            transfers.copy({ kind: 'user', userId: 'owner-1' }, NODE.id, input),
        ).resolves.toMatchObject({
            operationId: 'op-a',
        });
        const frame = header('app.js', 5);
        source.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, frame);
        source.emit.binary(FLEET_LINK_FRAME_KINDS.DATA, bytes('hello'));
        source.emit.binary(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
        const forwarded = destination.sent.filter(
            (sent) => sent.kind === FLEET_LINK_FRAME_KINDS.DATA,
        );
        expect(forwarded).toHaveLength(2);
        expect(Buffer.from(forwarded[0].payload)).toEqual(Buffer.from(frame));
        expect(destination.sent.some((sent) => sent.kind === FLEET_LINK_FRAME_KINDS.END)).toBe(
            true,
        );
        // The source hears credit only as the destination writes.
        expect(source.sent.filter((sent) => sent.kind === FLEET_LINK_FRAME_KINDS.ACK)).toHaveLength(
            0,
        );
        destination.emit.binary(FLEET_LINK_FRAME_KINDS.ACK, encodeFleetLinkAck(frame.byteLength)!);
        expect(source.sent.filter((sent) => sent.kind === FLEET_LINK_FRAME_KINDS.ACK)).toHaveLength(
            1,
        );
        destination.emit.json({
            type: 'files.unpacked',
            entries: 1,
            bytes: 5,
            replaced: 0,
            skipped: 0,
        });
        await settle();
        // One row on each computer, each naming the other (FR-27).
        const rows = (files.record as jest.Mock).mock.calls.filter(
            (call) => call[0] === 'node.files.copy',
        );
        expect(rows.map((call) => call[2]).sort()).toEqual([NODE.id, DEST].sort());
        expect(rows.find((call) => call[2] === NODE.id)![4]).toMatchObject({
            peerNodeId: DEST,
            outcome: 'done',
        });
    });

    it('closes the source when the destination fails, leaving nothing partial there (U9)', async () => {
        const { transfers, source, destination } = copySetup();
        await transfers.copy({ kind: 'user', userId: 'owner-1' }, NODE.id, input);
        destination.emit.close('operation_failed', 'disk full');
        expect(source.channel.close).toHaveBeenCalled();
    });

    it('asks a person to confirm a credential-shaped file and refuses an Agent (FR-17)', async () => {
        const person = copySetup({ credential: true });
        await expect(
            person.transfers.copy({ kind: 'user', userId: 'owner-1' }, NODE.id, input),
        ).rejects.toMatchObject({
            linkError: { code: 'confirmation_required' },
        });
        const agent = copySetup({ credential: true });
        await expect(
            agent.transfers.copy(
                { kind: 'agent', agentId: 'a1', ownerUserId: 'owner-1' },
                NODE.id,
                input,
            ),
        ).rejects.toMatchObject({ linkError: { code: 'permission_denied' } });
    });
});
