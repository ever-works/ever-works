import { Injectable, Logger, Optional } from '@nestjs/common';
import { FleetNodeRepository, FleetService } from '@ever-works/agent/fleet';
import {
    FLEET_FILES_LIMITS,
    FLEET_FILES_MESSAGES,
    FLEET_FILES_RECORD_TAGS,
    FLEET_FILES_STALL_TIMEOUT_MS,
    FLEET_FILES_TRANSFER_RETENTION_MS,
    FLEET_LINK_FRAME_KINDS,
    FleetFilesStreamTracker,
    decodeFleetFilesRecords,
    decodeFleetLinkAck,
    encodeFleetLinkAck,
    fleetFileBaseName,
    isFleetLinkErrorCode,
    sanitizeFleetFilesWritePolicy,
    type FleetFilesOperationKind,
    type FleetFilesOperationState,
    type FleetFilesOperationView,
    type FleetFilesTransfersResponse,
    type FleetFilesWritePolicy,
    type FleetLinkCloseReason,
} from '@ever-works/contracts';
import { randomUUID } from 'crypto';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkException, fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import { fleetLinkCallerUserId, type FleetLinkCaller } from '../../fleet-link/fleet-link.types';
import { FleetOperationsService } from '../../fleet-link/fleet-operations.service';
import { FleetZipWriter } from './fleet-files-zip';
import {
    FleetFilesService,
    parseFleetFilesLocation,
    parseFleetFilesNames,
    replyResult,
    type FleetFilesLocation,
} from './fleet-files.service';

/**
 * Files on computers (FL-11, plan §1 data flow, T-09) — the transfer bridge.
 *
 * **Download** (FR-10, FR-11): a `files` channel, `files.pack`, then the
 * node's files stream (`DATA` under `ACK` credit) turned into the browser's
 * shape as it arrives — one file as itself (with its length), several entries
 * or a folder as one `.zip` built on the fly (`fleet-files-zip.ts`, store
 * only). Credit is returned only once the HTTP response has taken the bytes
 * (`drain`), so a slow browser slows the machine and the platform never holds
 * more than the window (8 MiB) plus the socket's own buffer for a transfer.
 *
 * **Upload** (FR-12…FR-15): the browser sends the SAME files stream as the
 * request body (`application/octet-stream`, built from the picked files as a
 * lazy Blob — no multipart parser on the platform, lane log decision 2); this
 * re-frames it into whole records, proves every record (the contract's
 * decoder and tracker: no path out, exact sizes, ≤ 5 000 entries, ≤ 2 GiB),
 * and forwards each as a `DATA` frame only against the machine's `ACK`
 * credit — reading the request no faster than the machine writes. The
 * machine writes into a partial folder and moves entries into place on
 * `END` by the conflict policy (Skip by default).
 *
 * **Operations** (FR-14): every transfer is a record here — kind, bytes,
 * speed, state, the node's FL-02 operation id — read by the Files tab's
 * Operations strip (`GET …/files/transfers`) and cancellable (`DELETE …`,
 * or FL-02's `DELETE /api/fleet/operations/:id`). Records are per API replica
 * (lane log decision 6); the FL-02 operation is shared through the relay bus.
 *
 * **Limits** (CONTRACTS §10): 2 transfers per computer and 4 per person at
 * once (per replica), 2 GiB and 5 000 entries per transfer — refused
 * `limit_exceeded` before any byte moves.
 */

/** Where a download's bytes go (the controller adapts Express's response). */
export interface FleetFilesDownloadSink {
    /** Status 200 and these headers, before the first byte. */
    start(headers: Record<string, string>): void;
    /** False when the socket's buffer is full: wait for `onDrain`. */
    write(chunk: Buffer): boolean;
    onDrain(listener: () => void): void;
    end(): void;
    /** Abort the response (the browser shows a failed download, never a short "complete" one). */
    destroy(): void;
    /** The browser went away. */
    onClose(listener: () => void): void;
    readonly started: boolean;
}

export interface FleetFilesUploadInput {
    root: unknown;
    path?: unknown;
    policy?: FleetFilesWritePolicy;
    expectedEntries?: number;
    expectedBytes?: number;
    label?: string;
}

export interface FleetFilesUploadResult {
    transferId: string;
    operationId: string | null;
    entries: number;
    bytes: number;
    replaced: number;
    skipped: number;
    skippedLinks: number;
}

interface TransferRecord {
    view: FleetFilesOperationView;
    requesterUserId: string | null;
    ownerUserId: string;
    cancel: (() => void) | null;
    samples: Array<{ at: number; bytes: number }>;
    endedAtMs: number | null;
}

const CREDENTIAL_AGENT_HINT =
    'Only a person can download a credential-shaped file, after confirming';
const PACK_TIMEOUT_MS = 120_000;
const UNPACK_DONE_TIMEOUT_MS = 120_000;

/** `attachment; filename="…"; filename*=UTF-8''…` — never a caller-controlled header break. */
export function fleetFilesDisposition(name: string): string {
    const ascii = name.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120) || 'download';
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 200))}`;
}

function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

@Injectable()
export class FleetFilesTransferService {
    private readonly logger = new Logger(FleetFilesTransferService.name);
    private readonly transfers = new Map<string, TransferRecord>();
    private readonly moved = new Map<string, { day: string; bytes: number }>();

    constructor(
        private readonly files: FleetFilesService,
        private readonly fleet: FleetService,
        private readonly nodes: FleetNodeRepository,
        private readonly link: FleetLinkService,
        @Optional() private readonly operations?: FleetOperationsService,
    ) {}

    // ─── Records (the Operations strip) ────────────────────────────────────

    async transfersForUser(userId: string, nodeId: string): Promise<FleetFilesTransfersResponse> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        this.prune();
        const transfers = [...this.transfers.values()]
            .filter(
                (record) =>
                    (record.view.nodeId === nodeId || record.view.peerNodeId === nodeId) &&
                    (record.requesterUserId === userId || record.ownerUserId === userId),
            )
            .sort((a, b) => b.view.startedAt.localeCompare(a.view.startedAt))
            .slice(0, 20)
            .map((record) => this.snapshot(record));
        const counter = this.moved.get(nodeId);
        return {
            nodeId,
            transfers,
            todayBytes: counter && counter.day === today(Date.now()) ? counter.bytes : 0,
        };
    }

    /**
     * Cancel a transfer: on this replica, its channel is closed (the machine
     * removes anything partial); elsewhere, the node's FL-02 operation is
     * cancelled through the replica that holds its link.
     */
    async cancelForUser(
        userId: string,
        nodeId: string,
        transferId: string,
        operationId?: string | null,
    ): Promise<{ transferId: string; sent: boolean }> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        const record = this.transfers.get(transferId);
        if (record && (record.requesterUserId === userId || record.ownerUserId === userId)) {
            if (record.view.state !== 'running') return { transferId, sent: false };
            record.cancel?.();
            return { transferId, sent: true };
        }
        if (operationId && this.operations) {
            const result = await this.operations.requestCancel(operationId, userId);
            return { transferId, sent: result.sent };
        }
        throw fleetLinkError('not_found', 'That transfer has ended or runs elsewhere');
    }

    private begin(input: {
        kind: FleetFilesOperationKind;
        caller: FleetLinkCaller;
        nodeId: string;
        ownerUserId: string;
        location: FleetFilesLocation;
        label: string;
        entries: number;
        totalBytes: number | null;
        peerNodeId?: string | null;
    }): TransferRecord {
        const requesterUserId = fleetLinkCallerUserId(input.caller);
        let nodeRunning = 0;
        let userRunning = 0;
        for (const record of this.transfers.values()) {
            if (record.view.state !== 'running') continue;
            if (record.view.nodeId === input.nodeId || record.view.peerNodeId === input.nodeId)
                nodeRunning += 1;
            if (requesterUserId && record.requesterUserId === requesterUserId) userRunning += 1;
        }
        if (nodeRunning >= FLEET_FILES_LIMITS.maxConcurrentPerNode) {
            throw fleetLinkError(
                'limit_exceeded',
                `${FLEET_FILES_LIMITS.maxConcurrentPerNode} transfers are already running on this computer — wait for one to finish`,
                { limit: FLEET_FILES_LIMITS.maxConcurrentPerNode },
            );
        }
        if (userRunning >= FLEET_FILES_LIMITS.maxConcurrentPerUser) {
            throw fleetLinkError(
                'limit_exceeded',
                `You already run ${FLEET_FILES_LIMITS.maxConcurrentPerUser} transfers — wait for one to finish`,
                { limit: FLEET_FILES_LIMITS.maxConcurrentPerUser },
            );
        }
        const now = Date.now();
        const record: TransferRecord = {
            view: {
                id: randomUUID(),
                operationId: null,
                kind: input.kind,
                nodeId: input.nodeId,
                peerNodeId: input.peerNodeId ?? null,
                label: input.label,
                root: input.location.root,
                path: input.location.path,
                entries: input.entries,
                bytes: 0,
                totalBytes: input.totalBytes,
                state: 'running',
                startedAt: new Date(now).toISOString(),
                endedAt: null,
                bytesPerSec: null,
                error: null,
            },
            requesterUserId,
            ownerUserId: input.ownerUserId,
            cancel: null,
            samples: [{ at: now, bytes: 0 }],
            endedAtMs: null,
        };
        this.transfers.set(record.view.id, record);
        return record;
    }

    private progress(record: TransferRecord, delta: number): void {
        if (delta <= 0) return;
        record.view.bytes += delta;
        const now = Date.now();
        record.samples.push({ at: now, bytes: record.view.bytes });
        while (record.samples.length > 2 && now - record.samples[0].at > 5_000)
            record.samples.shift();
        const key = record.view.nodeId;
        const day = today(now);
        const counter = this.moved.get(key);
        if (!counter || counter.day !== day) this.moved.set(key, { day, bytes: delta });
        else counter.bytes += delta;
        if (record.view.peerNodeId) {
            const peer = this.moved.get(record.view.peerNodeId);
            if (!peer || peer.day !== day)
                this.moved.set(record.view.peerNodeId, { day, bytes: delta });
            else peer.bytes += delta;
        }
    }

    private end(
        record: TransferRecord,
        state: Exclude<FleetFilesOperationState, 'running'>,
        error?: { code: string; hint: string } | null,
    ): void {
        if (record.view.state !== 'running') return;
        const now = Date.now();
        record.view.state = state;
        record.view.endedAt = new Date(now).toISOString();
        record.view.bytesPerSec = null;
        record.view.error = error ?? null;
        record.endedAtMs = now;
        record.cancel = null;
    }

    private snapshot(record: TransferRecord): FleetFilesOperationView {
        const view = { ...record.view };
        if (view.state === 'running' && record.samples.length >= 2) {
            const first = record.samples[0];
            const last = record.samples[record.samples.length - 1];
            const seconds = (last.at - first.at) / 1000;
            view.bytesPerSec =
                seconds > 0 ? Math.round((last.bytes - first.bytes) / seconds) : null;
        }
        return view;
    }

    private prune(): void {
        const now = Date.now();
        for (const [id, record] of this.transfers) {
            if (
                record.endedAtMs !== null &&
                now - record.endedAtMs > FLEET_FILES_TRANSFER_RETENTION_MS
            ) {
                this.transfers.delete(id);
            }
        }
    }

    /** A channel's close as the transfer's end state. */
    private closeState(
        reason: FleetLinkCloseReason,
    ): Exclude<FleetFilesOperationState, 'running' | 'done'> {
        if (reason === 'resume_failed' || reason === 'unreachable') return 'interrupted';
        if (reason === 'normal' || reason === 'kill_switch') return 'cancelled';
        return 'failed';
    }

    // ─── Download ──────────────────────────────────────────────────────────

    async downloadForUser(
        userId: string,
        nodeId: string,
        input: { root: unknown; path?: unknown; entries: unknown; confirm?: boolean },
        sink: FleetFilesDownloadSink,
    ): Promise<void> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.download({ kind: 'user', userId }, nodeId, input, sink);
    }

    async download(
        caller: FleetLinkCaller,
        nodeId: string,
        input: { root: unknown; path?: unknown; entries: unknown; confirm?: boolean },
        sink: FleetFilesDownloadSink,
    ): Promise<void> {
        const location = parseFleetFilesLocation(input.root, input.path);
        const names = parseFleetFilesNames(input.entries, 'entries', FLEET_FILES_LIMITS.maxEntries);
        const node = await this.nodes.findById(nodeId);
        if (!node) throw fleetLinkError('not_found', 'no such computer');
        const record = this.begin({
            kind: 'download',
            caller,
            nodeId,
            ownerUserId: node.userId,
            location,
            label: names.length === 1 ? names[0] : `${names.length} items`,
            entries: names.length,
            totalBytes: null,
        });
        const audit = (details: Record<string, unknown>) =>
            this.files.record('node.files.read', caller, nodeId, node.userId, {
                root: location.root,
                path: location.path,
                entries: names.length,
                confirmationClass: input.confirm === true ? 'confirm' : 'plain',
                confirmed: input.confirm === true,
                ...details,
            });

        let channel: FleetLinkChannel | null = null;
        let mode: 'raw' | 'zip' | null = null;
        let zip: FleetZipWriter | null = null;
        let summary: Record<string, unknown> | null = null;
        let settled = false;
        let finish: (error?: unknown) => void = () => undefined;
        const finished = new Promise<void>((resolve, reject) => {
            finish = (error?: unknown) => (error ? reject(error) : resolve());
        });
        // A refusal before the stream starts is thrown by the request below; never an unhandled rejection.
        void finished.catch(() => undefined);
        const tracker = new FleetFilesStreamTracker();
        // Frames the node sends right behind its reply can arrive before the reply's continuation
        // runs (one socket chunk): they wait here until the response shape is chosen.
        const early: Array<{ kind: number; payload: Uint8Array }> = [];

        const fail = (
            state: Exclude<FleetFilesOperationState, 'running' | 'done'>,
            code: string,
            hint: string,
        ) => {
            if (settled) return;
            settled = true;
            this.end(record, state, { code, hint });
            if (channel && !channel.isClosed) channel.close('normal', state);
            if (sink.started) sink.destroy();
            void audit({ bytes: record.view.bytes, outcome: state, code });
            finish(
                sink.started
                    ? undefined
                    : fleetLinkError(isFleetLinkErrorCode(code) ? code : 'operation_failed', hint),
            );
        };

        const onData = (payload: Uint8Array) => {
            if (settled || !mode) return;
            const records = decodeFleetFilesRecords(payload);
            if (!records) {
                fail('failed', 'operation_failed', 'the computer sent a malformed transfer stream');
                return;
            }
            let delta = 0;
            for (const item of records) {
                const problem = tracker.push(item);
                if (problem) {
                    fail('failed', 'operation_failed', problem);
                    return;
                }
                if (item.tag === FLEET_FILES_RECORD_TAGS.header) {
                    if (mode === 'zip') zip!.entry(item.header);
                } else {
                    delta += item.bytes.byteLength;
                    if (mode === 'zip') zip!.data(item.bytes);
                    else
                        write(
                            Buffer.from(
                                item.bytes.buffer,
                                item.bytes.byteOffset,
                                item.bytes.byteLength,
                            ),
                        );
                }
            }
            this.progress(record, delta);
            const ack = () => {
                const frame = encodeFleetLinkAck(payload.byteLength);
                if (frame && channel && !channel.isClosed)
                    channel.sendBinary(FLEET_LINK_FRAME_KINDS.ACK, frame);
            };
            // Credit only once the response took the bytes: a slow browser slows the machine.
            if (lastWriteOk) ack();
            else sink.onDrain(ack);
        };
        let lastWriteOk = true;
        const write = (chunk: Buffer) => {
            lastWriteOk = sink.write(chunk);
        };
        const onEnd = () => {
            if (settled || !mode) return;
            if (!tracker.complete) {
                fail('failed', 'operation_failed', 'the transfer ended in the middle of a file');
                return;
            }
            settled = true;
            if (zip) zip.finish();
            sink.end();
            this.end(record, 'done');
            void audit({
                bytes: record.view.bytes,
                skippedLinks: typeof summary?.skippedLinks === 'number' ? summary.skippedLinks : 0,
                outcome: 'done',
            });
            if (channel && !channel.isClosed) channel.close('normal');
            finish();
        };
        const onFrame = (kind: number, payload: Uint8Array) => {
            if (settled) return;
            if (!mode) {
                early.push({ kind, payload });
                return;
            }
            if (kind === FLEET_LINK_FRAME_KINDS.DATA) {
                lastWriteOk = true;
                onData(payload);
            } else if (kind === FLEET_LINK_FRAME_KINDS.END) {
                onEnd();
            }
        };

        try {
            channel = await this.link.openChannel({
                nodeId,
                family: 'files',
                params: { root: location.root, path: location.path },
                caller,
                requirement: {
                    actionFamily: 'files',
                    stateChanging: false,
                    target: location.path || '/',
                },
                events: {
                    binary: (kind, payload) => onFrame(kind, payload),
                    json: (message) => {
                        if (message.type === FLEET_FILES_MESSAGES.packed) summary = message;
                    },
                    close: (reason, hint) => {
                        if (!settled)
                            fail(
                                this.closeState(reason),
                                reason === 'normal' ? 'unreachable' : reason,
                                hint ?? 'the computer closed the transfer',
                            );
                    },
                },
            });
        } catch (error) {
            this.end(record, 'failed', errorOf(error));
            await audit({ bytes: 0, outcome: 'refused', code: errorOf(error).code });
            throw error;
        }

        let accepted: { entries?: unknown; bytes?: unknown; single?: unknown; name?: unknown };
        let operationId: string | null = null;
        try {
            const reply = await channel.request(
                FLEET_FILES_MESSAGES.pack,
                {
                    entries: names,
                    allowCredentialShaped: caller.kind === 'user' && input.confirm === true,
                },
                { timeoutMs: PACK_TIMEOUT_MS },
            );
            if ('error' in reply && reply.error.code === 'confirmation_required') {
                const details = reply.error.details ?? {};
                const named = Array.isArray(details.credentialShaped)
                    ? (details.credentialShaped as string[])
                    : [];
                throw caller.kind === 'user'
                    ? fleetLinkError(
                          'confirmation_required',
                          `This looks like a credential file${named[0] ? ` (${fleetFileBaseName(named[0])})` : ''}. Download it anyway? It is sent only to your browser.`,
                          { class: 'confirm', ...details },
                      )
                    : fleetLinkError('permission_denied', CREDENTIAL_AGENT_HINT);
            }
            const result = replyResult(reply) as {
                operationId?: unknown;
                accepted?: { entries?: unknown; bytes?: unknown; single?: unknown; name?: unknown };
            } | null;
            accepted = result?.accepted ?? {};
            operationId = typeof result?.operationId === 'string' ? result.operationId : null;
        } catch (error) {
            if (!channel.isClosed) channel.close('normal');
            settled = true;
            this.end(record, 'failed', errorOf(error));
            await audit({ bytes: 0, outcome: 'refused', code: errorOf(error).code });
            throw error;
        }

        record.view.operationId = operationId;
        record.view.totalBytes = typeof accepted.bytes === 'number' ? accepted.bytes : null;
        record.view.entries =
            typeof accepted.entries === 'number' ? accepted.entries : names.length;
        if (operationId && this.operations) {
            this.operations.track({
                operationId,
                nodeId,
                family: 'files',
                verb: FLEET_FILES_MESSAGES.pack,
                requesterUserId: fleetLinkCallerUserId(caller),
                ownerUserId: node.userId,
            });
        }
        record.cancel = () => fail('cancelled', 'operation_failed', 'cancelled');
        sink.onClose(() => {
            if (!settled)
                fail('cancelled', 'operation_failed', 'the download was cancelled in the browser');
        });

        const single = accepted.single === true && typeof accepted.name === 'string';
        const fileName = single
            ? (accepted.name as string)
            : `${names.length === 1 ? names[0] : fleetFileBaseName(location.path) || 'files'}.zip`;
        const headers: Record<string, string> = {
            'Content-Type': single ? 'application/octet-stream' : 'application/zip',
            'Content-Disposition': fleetFilesDisposition(fileName),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'X-Fleet-Transfer-Id': record.view.id,
        };
        if (operationId) headers['X-Fleet-Operation-Id'] = operationId;
        if (single && typeof accepted.bytes === 'number')
            headers['Content-Length'] = String(accepted.bytes);
        if (!settled) {
            sink.start(headers);
            if (single) {
                mode = 'raw';
            } else {
                zip = new FleetZipWriter(write);
                mode = 'zip';
            }
            for (const frame of early.splice(0)) onFrame(frame.kind, frame.payload);
        }
        return finished;
    }

    // ─── Upload ────────────────────────────────────────────────────────────

    async uploadForUser(
        userId: string,
        nodeId: string,
        input: FleetFilesUploadInput,
        body: AsyncIterable<Uint8Array | Buffer | string>,
    ): Promise<FleetFilesUploadResult> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.upload({ kind: 'user', userId }, nodeId, input, body);
    }

    async upload(
        caller: FleetLinkCaller,
        nodeId: string,
        input: FleetFilesUploadInput,
        body: AsyncIterable<Uint8Array | Buffer | string>,
    ): Promise<FleetFilesUploadResult> {
        const location = parseFleetFilesLocation(input.root, input.path);
        const expectedEntries = input.expectedEntries ?? 0;
        const expectedBytes = input.expectedBytes ?? 0;
        // FR-16: refused before any byte moves.
        if (expectedEntries > FLEET_FILES_LIMITS.maxEntries) {
            throw fleetLinkError('limit_exceeded', 'Select fewer than 5,000 items', {
                limit: FLEET_FILES_LIMITS.maxEntries,
            });
        }
        if (expectedBytes > FLEET_FILES_LIMITS.maxOpBytes) {
            throw fleetLinkError(
                'limit_exceeded',
                'One transfer moves at most 2 GiB — select less',
                {
                    limit: FLEET_FILES_LIMITS.maxOpBytes,
                },
            );
        }
        const node = await this.nodes.findById(nodeId);
        if (!node) throw fleetLinkError('not_found', 'no such computer');
        const policy = sanitizeFleetFilesWritePolicy(input.policy);
        const record = this.begin({
            kind: 'upload',
            caller,
            nodeId,
            ownerUserId: node.userId,
            location,
            label: input.label?.slice(0, 200) || `${expectedEntries} items`,
            entries: expectedEntries,
            totalBytes: expectedBytes || null,
        });
        const audit = (details: Record<string, unknown>) =>
            this.files.record('node.files.write', caller, nodeId, node.userId, {
                root: location.root,
                path: location.path,
                confirmationClass: 'plain',
                policy: policy.replaceAll
                    ? 'replace-all'
                    : policy.replace?.length
                      ? 'replace-some'
                      : 'skip',
                ...details,
            });

        let credit = FLEET_FILES_LIMITS.windowBytes;
        let wake: (() => void) | null = null;
        let lastAckAt = Date.now();
        let closed: { reason: FleetLinkCloseReason; hint?: string } | null = null;
        let unpacked: Record<string, unknown> | null = null;
        let onUnpacked: (() => void) | null = null;
        const poke = () => {
            const next = wake;
            wake = null;
            next?.();
        };

        let channel: FleetLinkChannel;
        try {
            channel = await this.link.openChannel({
                nodeId,
                family: 'files',
                params: { root: location.root, path: location.path },
                caller,
                requirement: {
                    actionFamily: 'files',
                    stateChanging: true,
                    target: location.path || '/',
                },
                events: {
                    binary: (kind, payload) => {
                        if (kind !== FLEET_LINK_FRAME_KINDS.ACK) return;
                        const granted = decodeFleetLinkAck(payload);
                        if (granted && granted > 0) {
                            credit = Math.min(credit + granted, FLEET_FILES_LIMITS.windowBytes);
                            lastAckAt = Date.now();
                            poke();
                        }
                    },
                    json: (message) => {
                        if (message.type !== FLEET_FILES_MESSAGES.unpacked) return;
                        unpacked = message;
                        onUnpacked?.();
                        poke();
                    },
                    close: (reason, hint) => {
                        closed = { reason, ...(hint ? { hint } : {}) };
                        onUnpacked?.();
                        poke();
                    },
                },
            });
        } catch (error) {
            this.end(record, 'failed', errorOf(error));
            await audit({ entries: 0, bytes: 0, outcome: 'refused', code: errorOf(error).code });
            throw error;
        }

        let operationId: string | null = null;
        const abort = (
            state: Exclude<FleetFilesOperationState, 'running' | 'done'>,
            error: FleetLinkException,
        ) => {
            if (!channel.isClosed) channel.close('normal', state);
            this.end(record, state, { code: error.code, hint: error.linkError.hint });
            return error;
        };
        try {
            const reply = await channel.request(
                FLEET_FILES_MESSAGES.unpack,
                { policy, expectedEntries, expectedBytes },
                { timeoutMs: 30_000 },
            );
            const result = replyResult(reply) as { operationId?: unknown } | null;
            operationId = typeof result?.operationId === 'string' ? result.operationId : null;
        } catch (error) {
            const refusal =
                error instanceof FleetLinkException
                    ? error
                    : fleetLinkError('operation_failed', errorOf(error).hint);
            abort('failed', refusal);
            await audit({ entries: 0, bytes: 0, outcome: 'refused', code: refusal.code });
            throw refusal;
        }
        record.view.operationId = operationId;
        if (operationId && this.operations) {
            this.operations.track({
                operationId,
                nodeId,
                family: 'files',
                verb: FLEET_FILES_MESSAGES.unpack,
                requesterUserId: fleetLinkCallerUserId(caller),
                ownerUserId: node.userId,
            });
        }
        let cancelled = false;
        record.cancel = () => {
            cancelled = true;
            if (!channel.isClosed) channel.close('normal', 'cancelled');
            poke();
        };

        const tracker = new FleetFilesStreamTracker();
        const waitForCredit = async (bytes: number): Promise<void> => {
            while (credit < bytes) {
                if (closed || cancelled) throw closedError();
                if (Date.now() - lastAckAt > FLEET_FILES_STALL_TIMEOUT_MS) {
                    throw fleetLinkError('operation_failed', 'the computer stopped writing');
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    const timer = setTimeout(resolve, 5_000);
                    timer.unref?.();
                });
            }
            credit -= bytes;
        };
        const closedError = (): FleetLinkException => {
            if (cancelled) return fleetLinkError('operation_failed', 'cancelled');
            const close = closed as { reason: FleetLinkCloseReason; hint?: string } | null;
            if (close && close.reason !== 'normal' && isFleetLinkErrorCode(close.reason)) {
                return fleetLinkError(
                    close.reason,
                    close.hint ?? `${node.name} stopped the upload`,
                );
            }
            return fleetLinkError(
                'unreachable',
                close?.hint ?? `${node.name} went away during the upload`,
            );
        };

        try {
            let pending: Buffer = Buffer.alloc(0);
            for await (const raw of body) {
                const chunk =
                    typeof raw === 'string'
                        ? Buffer.from(raw)
                        : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
                pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
                for (;;) {
                    if (pending.length < 5) break;
                    const tag = pending.readUInt8(0);
                    const length = pending.readUInt32BE(1);
                    if (length > FLEET_FILES_LIMITS.chunkBytes - 5) {
                        throw fleetLinkError(
                            'invalid',
                            'the upload stream has a record larger than a frame',
                        );
                    }
                    const total = 5 + length;
                    if (pending.length < total) break;
                    const frame = pending.subarray(0, total);
                    const decoded = decodeFleetFilesRecords(frame);
                    if (!decoded || decoded.length !== 1)
                        throw fleetLinkError('invalid', 'the upload stream is malformed');
                    const problem = tracker.push(decoded[0]);
                    if (problem) {
                        throw fleetLinkError(
                            /items|GiB/.test(problem) ? 'limit_exceeded' : 'invalid',
                            problem,
                        );
                    }
                    await waitForCredit(total);
                    if (closed || cancelled) throw closedError();
                    if (!channel.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, new Uint8Array(frame)))
                        throw closedError();
                    if (tag === FLEET_FILES_RECORD_TAGS.bytes) this.progress(record, length);
                    pending = pending.subarray(total);
                }
            }
            if (pending.length > 0 || !tracker.complete) {
                throw fleetLinkError('invalid', 'the upload ended in the middle of a file');
            }
            if (closed || cancelled) throw closedError();
            channel.sendBinary(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
            await new Promise<void>((resolve) => {
                if (unpacked || closed) {
                    resolve();
                    return;
                }
                onUnpacked = resolve;
                const timer = setTimeout(resolve, UNPACK_DONE_TIMEOUT_MS);
                timer.unref?.();
            });
        } catch (error) {
            const refusal =
                error instanceof FleetLinkException
                    ? error
                    : cancelled
                      ? fleetLinkError('operation_failed', 'cancelled')
                      : fleetLinkError('operation_failed', 'the upload was interrupted');
            const state = cancelled
                ? 'cancelled'
                : refusal.code === 'unreachable'
                  ? 'interrupted'
                  : 'failed';
            abort(state, refusal);
            await audit({
                entries: tracker.entries,
                bytes: record.view.bytes,
                outcome: state,
                code: refusal.code,
            });
            throw refusal;
        }

        const done = unpacked as Record<string, unknown> | null;
        if (!channel.isClosed) channel.close('normal');
        if (!done || done.error) {
            const raw = done?.error as { code?: unknown; hint?: unknown } | undefined;
            const refusal =
                raw && isFleetLinkErrorCode(raw.code)
                    ? fleetLinkError(
                          raw.code,
                          typeof raw.hint === 'string'
                              ? raw.hint
                              : `${node.name} could not write the files`,
                      )
                    : done
                      ? fleetLinkError('operation_failed', `${node.name} could not write the files`)
                      : closedError();
            this.end(record, refusal.code === 'unreachable' ? 'interrupted' : 'failed', {
                code: refusal.code,
                hint: refusal.linkError.hint,
            });
            await audit({
                entries: tracker.entries,
                bytes: record.view.bytes,
                outcome: 'failed',
                code: refusal.code,
            });
            throw refusal;
        }
        const count = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : 0);
        const outcome: FleetFilesUploadResult = {
            transferId: record.view.id,
            operationId,
            entries: count(done.entries),
            bytes: count(done.bytes),
            replaced: count(done.replaced),
            skipped: count(done.skipped),
            skippedLinks: count(done.skippedLinks),
        };
        record.view.replaced = outcome.replaced;
        record.view.skipped = outcome.skipped;
        record.view.skippedLinks = outcome.skippedLinks;
        this.end(record, 'done');
        await audit({
            entries: outcome.entries,
            bytes: outcome.bytes,
            replaced: outcome.replaced,
            skipped: outcome.skipped,
            outcome: 'done',
        });
        return outcome;
    }
}

function errorOf(error: unknown): { code: string; hint: string } {
    if (error instanceof FleetLinkException)
        return { code: error.code, hint: error.linkError.hint };
    return {
        code: 'internal',
        hint: error instanceof Error ? error.message.split(/\r?\n/, 1)[0].slice(0, 300) : 'failed',
    };
}
