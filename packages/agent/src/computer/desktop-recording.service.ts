import { BeforeApplicationShutdown, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    decodeDesktopRecordingChunk,
    encodeDesktopRecordingChunk,
    fleetDesktopRecordingRetentionDays,
    isFleetDesktopRecordingStopReason,
    FLEET_DESKTOP_RECORDING_CHUNK_MS,
    FLEET_DESKTOP_RECORDING_KEYFRAME_EVERY_MS,
    FLEET_DESKTOP_RECORDING_MAX_BYTES,
    FLEET_DESKTOP_RECORDING_MAX_MS,
    FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MAX,
    FLEET_LINK_FRAME_KINDS,
    type FleetDesktopRecordingEntry,
    type FleetDesktopRecordingStopReason,
    type FleetDesktopRecordingTrigger,
    type FleetDesktopRecordingView,
} from '@ever-works/contracts';
import type { ComputerSession } from '../entities/computer-session.entity';
import { FleetAuditService } from '../fleet/fleet-audit.service';
import { FleetNodeRepository } from '../fleet/fleet-node.repository';
import { ComputerSessionRepository } from './computer-session.repository';

/**
 * Desktop view & control (FL-07 P2.C, T-38 … T-40, FR-48 … FR-56) — the
 * recordings of Desktop views: written while a view is live, read back by its
 * player, deleted by the computer's owner or by the nightly sweep.
 *
 * What is recorded is what the view received (the platform taps the viewer
 * gateway's node → viewer frames of ONE socket of the view, never the
 * controller's input): keyframes at most one a second (FR-50) and the changed
 * tiles between kept keyframes, in 60-second chunks (`EWR1` containers)
 * written through the configured storage plugin ({@link DESKTOP_RECORDING_STORAGE}).
 * Tiles that arrive while no keyframe is kept are dropped until the next kept
 * keyframe, so a replay never paints a tile over the wrong picture.
 *
 * The view's `computer_sessions` row carries the recording (`recordingRef` =
 * the storage key of the recording's index object, never shown; bytes,
 * duration, expiry, why it stopped, `recorded`). The index lists the chunk
 * keys and is rewritten after every chunk. The row's `recordingRef` moves
 * only by compare-and-set: a writer that lost (another API replica wrote the
 * view's recording meanwhile) merges its chunks into the newer index, so no
 * chunk is ever orphaned. Every write stamps a provisional expiry (retention
 * plus the 4-hour cap), so even a crash leaves nothing the sweep cannot find.
 *
 * Caps (FR-50): 200 MB (buffered and queued bytes included) or 4 hours stops
 * the recording (`size-cap` / `time-cap`) and the view goes on. A storage
 * failure, a storage call that does not answer in time, or a write queue that
 * keeps growing stops it `storage-failed` and the view goes on (FR-55). Every
 * start, stop and delete is audited (`node.desktop.recording.*`).
 */

/** The storage plugin's three calls this service needs (`IStoragePlugin`'s subset). */
export interface DesktopRecordingStoragePort {
    readonly providerName: string;
    putObject(input: {
        buffer: Buffer;
        filename: string;
        mimeType: string;
        size: number;
        ownerId?: string;
    }): Promise<{ key: string }>;
    getObject(key: string): Promise<{ buffer: Buffer }>;
    deleteObject(key: string): Promise<void>;
}

/** DI token: the API binds it to the active storage backend. Unbound, nothing is recorded (`storage-failed`). */
export const DESKTOP_RECORDING_STORAGE = Symbol('DESKTOP_RECORDING_STORAGE');

/** A chunk is written early once its buffered pictures reach this size. */
export const DESKTOP_RECORDING_FLUSH_BYTES = 8 * 1024 * 1024;

/** Most chunk writes waiting at once; one more means storage cannot keep up (`storage-failed`). */
export const DESKTOP_RECORDING_MAX_QUEUED = 4;

/** One storage call that has not answered in this long has failed. */
export const DESKTOP_RECORDING_STORAGE_TIMEOUT_MS = 30_000;

/** Most rows one sweep pass reads, and most passes one sweep runs. */
export const DESKTOP_RECORDING_SWEEP_BATCH = 100;
export const DESKTOP_RECORDING_SWEEP_PASSES = 10;

/** How often a writer that lost the row's compare-and-set merges and tries again. */
const RECORDING_CAS_ATTEMPTS = 3;

/** Most failure notes this replica keeps (one per view; the row says it too). */
const MAX_FAILURE_NOTES = 1_000;

const DAY_MS = 86_400_000;

interface RecordingIndexChunk {
    seq: number;
    key: string;
    startMs: number;
    endMs: number;
    bytes: number;
}

/** The index object (stored; its key is the row's `recordingRef`). Never sent to a browser as is. */
interface RecordingIndex {
    schemaVersion: 1;
    viewId: string;
    trigger: FleetDesktopRecordingTrigger;
    startedAt: string;
    chunks: RecordingIndexChunk[];
}

interface LiveRecording {
    viewId: string;
    nodeId: string;
    ownerUserId: string;
    actorUserId: string;
    trigger: FleetDesktopRecordingTrigger;
    startedAtMs: number;
    retentionDays: number;
    index: RecordingIndex;
    /** The index key this writer last put on the row (null before its first chunk). */
    indexKey: string | null;
    entries: FleetDesktopRecordingEntry[];
    bufferedBytes: number;
    /** Bytes handed to the writer and not yet stored. */
    queuedBytes: number;
    queuedBatches: number;
    chunkStartMs: number;
    storedBytes: number;
    lastKeyframeMs: number;
    /** False until a keyframe is kept, and again after any picture is dropped. */
    tilesFollow: boolean;
    flushing: Promise<void>;
    stopped: boolean;
    /** A write failed: the stop says `storage-failed` whatever it was asked. */
    failedWrite: boolean;
}

export interface DesktopRecordingStart {
    viewId: string;
    nodeId: string;
    ownerUserId: string;
    /** Who the view belongs to (audited as the actor of the start). */
    actorUserId: string;
    trigger: FleetDesktopRecordingTrigger;
}

class StorageTimeout extends Error {
    constructor() {
        super('the storage did not answer in time');
    }
}

@Injectable()
export class DesktopRecordingService implements BeforeApplicationShutdown {
    private readonly logger = new Logger(DesktopRecordingService.name);
    private readonly live = new Map<string, LiveRecording>();
    /** Every start and stop of one view runs in order: a start waits for that view's pending stop. */
    private readonly ops = new Map<string, Promise<unknown>>();
    /** Why a view's recording could not start or stopped on a failure (this replica; the row says it too). */
    private readonly failures = new Map<string, string>();

    constructor(
        private readonly sessions: ComputerSessionRepository,
        private readonly nodes: FleetNodeRepository,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional()
        @Inject(DESKTOP_RECORDING_STORAGE)
        private readonly storage?: DesktopRecordingStoragePort | null,
    ) {}

    /** The wall clock (a method, so a spec can move it). */
    protected now(): number {
        return Date.now();
    }

    /** Is this view being recorded on this replica right now? */
    isRecording(viewId: string): boolean {
        const live = this.live.get(viewId);
        return Boolean(live && !live.stopped);
    }

    /** Why this view is not being recorded although it should be (FR-55), or null. */
    failureOf(viewId: string): string | null {
        return this.failures.get(viewId) ?? null;
    }

    /** A shutting-down replica writes what it buffered while the database is still there. */
    async beforeApplicationShutdown(): Promise<void> {
        await this.stopAll('view-ended').catch(() => undefined);
    }

    /**
     * Start recording a view (idempotent). A view recorded before — on this
     * replica or another — continues its recording (the index is read back).
     * Answers false when it cannot record, after noting why (FR-55).
     */
    start(input: DesktopRecordingStart): Promise<boolean> {
        return this.serial(input.viewId, () => this.begin(input));
    }

    /** Stop recording a view: write what is buffered, the index, and the row. Idempotent. */
    stop(viewId: string, reason: FleetDesktopRecordingStopReason): Promise<void> {
        return this.serial(viewId, () => this.end(viewId, reason));
    }

    /** Write what is buffered now (the view has no socket left: its tail must not wait). */
    flushNow(viewId: string): void {
        const live = this.live.get(viewId);
        if (live && !live.stopped) this.queueFlush(live);
    }

    /**
     * One picture the view received (`FRAME` 20 or `TILES` 23). Never throws,
     * never blocks the stream: chunk writes run behind it.
     */
    push(viewId: string, kind: number, payload: Uint8Array): void {
        const live = this.live.get(viewId);
        if (!live || live.stopped) return;
        const now = this.now();
        if (now - live.startedAtMs >= FLEET_DESKTOP_RECORDING_MAX_MS) {
            void this.stop(viewId, 'time-cap');
            return;
        }
        if (kind === FLEET_LINK_FRAME_KINDS.FRAME) {
            // FR-50: at most one full picture a second.
            if (now - live.lastKeyframeMs < FLEET_DESKTOP_RECORDING_KEYFRAME_EVERY_MS) {
                live.tilesFollow = false;
                return;
            }
            live.lastKeyframeMs = now;
            live.tilesFollow = true;
        } else if (kind === FLEET_LINK_FRAME_KINDS.TILES) {
            // A tile only ever paints over the keyframe it followed.
            if (!live.tilesFollow) return;
        } else {
            return;
        }
        const pending = live.storedBytes + live.queuedBytes + live.bufferedBytes;
        if (pending + payload.byteLength + 9 > FLEET_DESKTOP_RECORDING_MAX_BYTES) {
            void this.stop(viewId, 'size-cap');
            return;
        }
        // A minute of pictures is one chunk: this picture starts the next one.
        if (
            live.entries.length > 0 &&
            now - live.chunkStartMs >= FLEET_DESKTOP_RECORDING_CHUNK_MS
        ) {
            this.queueFlush(live);
        }
        if (live.entries.length === 0) live.chunkStartMs = now;
        live.entries.push({
            tMs: Math.max(0, Math.round(now - live.startedAtMs)),
            kind: kind as 20 | 23,
            payload: new Uint8Array(payload),
        });
        live.bufferedBytes += payload.byteLength + 9;
        if (live.bufferedBytes >= DESKTOP_RECORDING_FLUSH_BYTES) this.queueFlush(live);
    }

    /** Stop every recording of this replica (shutdown). */
    async stopAll(reason: FleetDesktopRecordingStopReason): Promise<void> {
        await Promise.all([...this.live.keys()].map((viewId) => this.stop(viewId, reason)));
    }

    // ─── Reading (the player) ───────────────────────────────────────────────

    /** The recordings of one computer, newest first (rows that still have one). */
    async list(nodeId: string, nodeName: string): Promise<FleetDesktopRecordingView[]> {
        const rows = await this.sessions.findDesktopRecordingsForNode(nodeId, 200);
        return rows.map((row) => this.viewOf(row, nodeName, null));
    }

    /** One recording with its chunk list (keys never leave the platform). */
    async read(
        viewId: string,
        nodeId: string,
        nodeName: string,
    ): Promise<FleetDesktopRecordingView | null> {
        const row = await this.sessions.findById(viewId);
        if (!row || row.nodeId !== nodeId || row.source !== 'desktop' || !row.recordingRef)
            return null;
        const index = await this.readIndex(row.recordingRef);
        return this.viewOf(row, nodeName, index);
    }

    /** One chunk's bytes, or null. */
    async chunk(viewId: string, nodeId: string, seq: number): Promise<Uint8Array | null> {
        const row = await this.sessions.findById(viewId);
        if (
            !row ||
            row.nodeId !== nodeId ||
            row.source !== 'desktop' ||
            !row.recordingRef ||
            !this.storage
        ) {
            return null;
        }
        const index = await this.readIndex(row.recordingRef);
        const entry = index?.chunks.find((chunk) => chunk.seq === seq);
        if (!entry) return null;
        try {
            const { buffer } = await this.timed(this.storage.getObject(entry.key));
            const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            return decodeDesktopRecordingChunk(bytes) ? bytes : null;
        } catch {
            return null;
        }
    }

    /**
     * Delete a recording now (the owner's "Delete now", or the sweep): every
     * object first, the row's recording fields second — a failed or unsure
     * object delete leaves the row, so the next sweep tries again. True when gone.
     */
    async remove(viewId: string, actorUserId: string | null): Promise<boolean> {
        if (this.isRecording(viewId)) await this.stop(viewId, 'deleted');
        const row = await this.sessions.findById(viewId);
        if (!row || row.source !== 'desktop' || !row.recordingRef) return false;
        if (!(await this.deleteObjects(row.recordingRef))) return false;
        await this.sessions.setRecording(viewId, {
            recordingRef: null,
            recordingBytes: 0,
            recordingExpiresAt: null,
            recordingStoppedReason: 'deleted',
        });
        await this.audit?.tryRecord({
            action: 'node.desktop.recording.delete',
            actorUserId,
            ownerUserId: row.userId,
            nodeId: row.nodeId,
            details: {
                family: 'desktop',
                target: viewId,
                source: 'desktop',
                requestedBy: actorUserId ? `user:${actorUserId}` : 'system:computer-recording-gc',
                confirmationClass: actorUserId ? 'confirm' : 'plain',
                outcome: 'deleted',
                bytes: Number(row.recordingBytes ?? 0) || 0,
            },
        });
        return true;
    }

    /**
     * The nightly retention sweep (T-40, `computer-recording-gc`): every
     * recording past its expiry — and every ended one that never got an expiry
     * and is older than the longest retention — is deleted (object first, row
     * second). A row that fails is skipped for the rest of the run, so it never
     * blocks the ones behind it. Nothing is deleted on read.
     */
    async sweepExpired(): Promise<{ deleted: number; failed: number }> {
        const now = new Date(this.now());
        const orphanCutoff = new Date(
            now.getTime() - FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MAX * DAY_MS,
        );
        const failedIds: string[] = [];
        let deleted = 0;
        for (let pass = 0; pass < DESKTOP_RECORDING_SWEEP_PASSES; pass += 1) {
            const rows = await this.sessions.findExpiredDesktopRecordings(
                now,
                DESKTOP_RECORDING_SWEEP_BATCH,
                orphanCutoff,
                failedIds,
            );
            if (rows.length === 0) break;
            for (const row of rows) {
                try {
                    if (await this.remove(row.id, null)) deleted += 1;
                    else failedIds.push(row.id);
                } catch (error) {
                    failedIds.push(row.id);
                    this.logger.warn(`desktop recording ${row.id}: not swept: ${message(error)}`);
                }
            }
        }
        return { deleted, failed: failedIds.length };
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /** Run one start / stop of a view after the ones before it. */
    private serial<T>(viewId: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.ops.get(viewId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(fn);
        const settled = next.catch(() => undefined);
        this.ops.set(viewId, settled);
        void settled.finally(() => {
            if (this.ops.get(viewId) === settled) this.ops.delete(viewId);
        });
        return next;
    }

    private async begin(input: DesktopRecordingStart): Promise<boolean> {
        if (this.isRecording(input.viewId)) return true;
        if (!this.storage) {
            this.noteFailure(input.viewId, 'storage-unavailable');
            await this.markSkipped(input.viewId, 'storage-unavailable');
            return false;
        }
        const row = await this.sessions.findById(input.viewId);
        if (!row || row.status === 'ended' || row.source !== 'desktop') return false;
        const now = this.now();
        let index: RecordingIndex = {
            schemaVersion: 1,
            viewId: input.viewId,
            trigger: input.trigger,
            startedAt: new Date(now).toISOString(),
            chunks: [],
        };
        let storedBytes = 0;
        if (row.recordingRef) {
            // Continue it — or, when its index cannot be read, record nothing rather than orphan it.
            const previous = await this.readIndex(row.recordingRef);
            if (!previous) {
                this.noteFailure(input.viewId, 'storage-failed');
                await this.markSkipped(input.viewId, 'storage-unavailable');
                return false;
            }
            index = previous;
            storedBytes = Number(row.recordingBytes ?? 0) || 0;
        }
        const startedAtMs = Date.parse(index.startedAt);
        const node = await this.nodes.findById(input.nodeId).catch(() => null);
        const live: LiveRecording = {
            viewId: input.viewId,
            nodeId: input.nodeId,
            ownerUserId: input.ownerUserId,
            actorUserId: input.actorUserId,
            trigger: input.trigger,
            startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : now,
            retentionDays: fleetDesktopRecordingRetentionDays(node?.recordingRetentionDays),
            index,
            indexKey: row.recordingRef ?? null,
            entries: [],
            bufferedBytes: 0,
            queuedBytes: 0,
            queuedBatches: 0,
            chunkStartMs: now,
            storedBytes,
            lastKeyframeMs: -Infinity,
            tilesFollow: false,
            flushing: Promise.resolve(),
            stopped: false,
            failedWrite: false,
        };
        if (
            now - live.startedAtMs >= FLEET_DESKTOP_RECORDING_MAX_MS ||
            storedBytes >= FLEET_DESKTOP_RECORDING_MAX_BYTES
        ) {
            return false;
        }
        this.live.set(input.viewId, live);
        this.failures.delete(input.viewId);
        // A provisional expiry from the first moment: a crash leaves nothing the sweep cannot find.
        await this.sessions
            .setRecording(input.viewId, {
                recordingExpiresAt: this.provisionalExpiry(live),
                recordingStoppedReason: null,
            })
            .catch(() => undefined);
        await this.recordAudit('node.desktop.recording.start', live, {
            outcome: 'started',
            trigger: input.trigger,
        });
        return true;
    }

    private async end(viewId: string, reason: FleetDesktopRecordingStopReason): Promise<void> {
        const live = this.live.get(viewId);
        if (!live || live.stopped) return;
        live.stopped = true;
        this.queueFlush(live);
        await live.flushing;
        if (this.live.get(viewId) === live) this.live.delete(viewId);
        const stoppedReason: FleetDesktopRecordingStopReason = live.failedWrite
            ? 'storage-failed'
            : reason;
        const endedAt = new Date(this.now());
        const durationMs = Math.max(0, endedAt.getTime() - live.startedAtMs);
        // The computer's retention as it is NOW: a value changed during the view applies to it (FL-07 P3).
        const node = await this.nodes.findById(live.nodeId).catch(() => null);
        if (node) live.retentionDays = fleetDesktopRecordingRetentionDays(node.recordingRetentionDays);
        const patch: Partial<ComputerSession> = {
            recordingDurationMs: durationMs,
            recordingBytes: live.storedBytes,
            recordingExpiresAt: new Date(endedAt.getTime() + live.retentionDays * DAY_MS),
            recordingStoppedReason: stoppedReason,
        };
        if (live.indexKey) {
            patch.recordingRef = live.indexKey;
            patch.recorded = true;
        }
        // Only over the index this writer put there: a newer one (another replica) keeps its own fields.
        const written = await this.sessions
            .swapRecordingRef(viewId, live.indexKey, patch)
            .catch((error: unknown) => {
                this.logger.warn(`desktop recording ${viewId}: row not updated: ${message(error)}`);
                return false;
            });
        if (!written) {
            await this.sessions
                .setRecording(viewId, { recordingExpiresAt: patch.recordingExpiresAt })
                .catch(() => undefined);
        }
        if (reason === 'view-ended' && !live.failedWrite) this.failures.delete(viewId);
        await this.recordAudit('node.desktop.recording.stop', live, {
            outcome: live.failedWrite ? 'failed' : 'stopped',
            stoppedReason,
            durationMs,
            bytes: live.storedBytes,
        });
    }

    /** Hand the buffered pictures to the writer as one chunk (in order, one write at a time). */
    private queueFlush(live: LiveRecording): void {
        if (live.entries.length === 0) return;
        if (live.queuedBatches >= DESKTOP_RECORDING_MAX_QUEUED) {
            // Storage cannot keep up: stop before the queue eats the process.
            live.entries = [];
            live.bufferedBytes = 0;
            void this.failed(live, 'the storage cannot keep up with the recording');
            return;
        }
        const batch = live.entries;
        const bytes = live.bufferedBytes;
        live.entries = [];
        live.bufferedBytes = 0;
        live.queuedBytes += bytes;
        live.queuedBatches += 1;
        live.flushing = live.flushing
            .then(() => this.flush(live, batch))
            .catch(() => undefined)
            .finally(() => {
                live.queuedBytes = Math.max(0, live.queuedBytes - bytes);
                live.queuedBatches = Math.max(0, live.queuedBatches - 1);
            });
    }

    /** Write one chunk, then the index, then the row (compare-and-set). A failure stops the recording. */
    private async flush(live: LiveRecording, entries: FleetDesktopRecordingEntry[]): Promise<void> {
        if (entries.length === 0 || live.failedWrite) return;
        const storage = this.storage;
        const bytes = encodeDesktopRecordingChunk(entries);
        if (!storage || !bytes) {
            await this.failed(live, 'the chunk could not be encoded');
            return;
        }
        const startMs = entries[0].tMs;
        const endMs = entries[entries.length - 1].tMs;
        try {
            const put = await this.timed(
                storage.putObject({
                    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                    filename: `desktop-recording-${live.viewId}.ewrec`,
                    mimeType: 'application/octet-stream',
                    size: bytes.byteLength,
                    ownerId: live.ownerUserId,
                }),
            );
            live.index.chunks.push({
                seq: live.index.chunks.length,
                key: put.key,
                startMs,
                endMs,
                bytes: bytes.byteLength,
            });
            live.storedBytes += bytes.byteLength;
            await this.publishIndex(live, endMs);
        } catch (error) {
            await this.failed(live, message(error));
        }
    }

    /**
     * Put the index and move the row to it — only over the index this writer
     * last put there. When another writer moved it meanwhile, merge this
     * writer's chunks into that newer index and try again; no chunk is lost.
     */
    private async publishIndex(live: LiveRecording, endMs: number): Promise<void> {
        const storage = this.storage as DesktopRecordingStoragePort;
        const superseded: string[] = [];
        for (let attempt = 0; attempt < RECORDING_CAS_ATTEMPTS; attempt += 1) {
            const indexBytes = Buffer.from(JSON.stringify(live.index), 'utf8');
            const written = await this.timed(
                storage.putObject({
                    buffer: indexBytes,
                    filename: `desktop-recording-${live.viewId}-index.json`,
                    mimeType: 'application/json',
                    size: indexBytes.byteLength,
                    ownerId: live.ownerUserId,
                }),
            );
            const moved = await this.sessions.swapRecordingRef(live.viewId, live.indexKey, {
                recordingRef: written.key,
                recordingBytes: live.storedBytes,
                recordingDurationMs: Math.max(0, endMs),
                recordingExpiresAt: this.provisionalExpiry(live),
                recorded: true,
            });
            if (moved) {
                if (live.indexKey && live.indexKey !== written.key) superseded.push(live.indexKey);
                live.indexKey = written.key;
                for (const key of superseded)
                    await storage.deleteObject(key).catch(() => undefined);
                return;
            }
            // Lost: this unpublished index goes, and the newer one absorbs this writer's chunks.
            await storage.deleteObject(written.key).catch(() => undefined);
            const row = await this.sessions.findById(live.viewId);
            const newer = row?.recordingRef ? await this.readIndex(row.recordingRef) : null;
            if (!row?.recordingRef || !newer)
                throw new Error('the recording index moved and cannot be read');
            live.index = mergeIndexes(newer, live.index);
            live.indexKey = row.recordingRef;
            live.storedBytes = live.index.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
        }
        throw new Error('the recording index kept moving');
    }

    /** FR-55: storage failed — the recording stops, the view goes on, the row says why. */
    private async failed(live: LiveRecording, why: string): Promise<void> {
        this.logger.warn(`desktop recording ${live.viewId} stopped: ${why}`);
        this.noteFailure(live.viewId, 'storage-failed');
        live.failedWrite = true;
        if (live.stopped) return;
        live.stopped = true;
        live.entries = [];
        if (this.live.get(live.viewId) === live) this.live.delete(live.viewId);
        await this.sessions
            .setRecording(live.viewId, {
                recordingStoppedReason: 'storage-failed',
                recordingSkippedReason: 'storage-unavailable',
                recordingExpiresAt: new Date(this.now() + live.retentionDays * DAY_MS),
            })
            .catch(() => undefined);
        await this.recordAudit('node.desktop.recording.stop', live, {
            outcome: 'failed',
            stoppedReason: 'storage-failed',
        });
    }

    private provisionalExpiry(live: LiveRecording): Date {
        return new Date(this.now() + live.retentionDays * DAY_MS + FLEET_DESKTOP_RECORDING_MAX_MS);
    }

    private noteFailure(viewId: string, reason: string): void {
        if (this.failures.size >= MAX_FAILURE_NOTES) {
            const oldest = this.failures.keys().next().value;
            if (oldest !== undefined) this.failures.delete(oldest);
        }
        this.failures.set(viewId, reason);
    }

    private async markSkipped(viewId: string, reason: string): Promise<void> {
        await this.sessions
            .setRecording(viewId, { recordingSkippedReason: reason })
            .catch(() => undefined);
    }

    /** A storage call bounded in time: one that hangs fails the recording instead of holding it. */
    private timed<T>(call: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new StorageTimeout()),
                DESKTOP_RECORDING_STORAGE_TIMEOUT_MS,
            );
            (timer as { unref?: () => void }).unref?.();
        });
        return Promise.race([call, timeout]).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    private async readIndex(key: string): Promise<RecordingIndex | null> {
        if (!this.storage) return null;
        try {
            const { buffer } = await this.timed(this.storage.getObject(key));
            const value = JSON.parse(buffer.toString('utf8')) as Partial<RecordingIndex>;
            if (
                value?.schemaVersion !== 1 ||
                !Array.isArray(value.chunks) ||
                typeof value.startedAt !== 'string'
            ) {
                return null;
            }
            const chunks = value.chunks.filter(
                (chunk): chunk is RecordingIndexChunk =>
                    Boolean(chunk) &&
                    Number.isInteger(chunk.seq) &&
                    typeof chunk.key === 'string' &&
                    Number.isFinite(chunk.startMs) &&
                    Number.isFinite(chunk.endMs) &&
                    Number.isFinite(chunk.bytes),
            );
            return {
                schemaVersion: 1,
                viewId: String(value.viewId ?? ''),
                trigger: value.trigger === 'watch-opt-in' ? 'watch-opt-in' : 'control',
                startedAt: value.startedAt,
                chunks,
            };
        } catch {
            return null;
        }
    }

    /**
     * Every object of a recording (chunks, then the index). False when any
     * delete failed — or when the index cannot be read, since its chunks could
     * not be found: the row stays and the next sweep tries again.
     */
    private async deleteObjects(indexKey: string): Promise<boolean> {
        if (!this.storage) return false;
        const index = await this.readIndex(indexKey);
        if (!index) {
            this.logger.warn(
                'desktop recording index unreadable: the recording is kept for the next sweep',
            );
            return false;
        }
        try {
            for (const chunk of index.chunks)
                await this.timed(this.storage.deleteObject(chunk.key));
            await this.timed(this.storage.deleteObject(indexKey));
            return true;
        } catch (error) {
            this.logger.warn(`desktop recording objects not deleted: ${message(error)}`);
            return false;
        }
    }

    private viewOf(
        row: ComputerSession,
        nodeName: string,
        index: RecordingIndex | null,
    ): FleetDesktopRecordingView {
        const startedAtMs = index
            ? Date.parse(index.startedAt)
            : new Date(row.startedAt ?? row.createdAt).getTime();
        const view: FleetDesktopRecordingView = {
            viewId: row.id,
            nodeId: row.nodeId,
            nodeName,
            source: 'desktop',
            displayId: row.displayId ?? null,
            quality: row.quality,
            openedByUserId: row.openedByUserId,
            trigger: index?.trigger ?? 'control',
            startedAt: new Date(
                Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
            ).toISOString(),
            endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
            durationMs: Number(row.recordingDurationMs ?? 0) || 0,
            bytes: Number(row.recordingBytes ?? 0) || 0,
            expiresAt: row.recordingExpiresAt
                ? new Date(row.recordingExpiresAt).toISOString()
                : null,
            stoppedReason: isFleetDesktopRecordingStopReason(row.recordingStoppedReason)
                ? row.recordingStoppedReason
                : null,
            storage: this.storage?.providerName ?? 'none',
            spans: (row.controlSpans ?? []).map((span) => ({
                userId: span.userId,
                startMs: Math.max(0, Date.parse(span.startedAt) - startedAtMs),
                endMs: span.endedAt ? Math.max(0, Date.parse(span.endedAt) - startedAtMs) : null,
            })),
        };
        if (index) {
            view.chunks = index.chunks.map((chunk) => ({
                seq: chunk.seq,
                startMs: chunk.startMs,
                endMs: chunk.endMs,
                bytes: chunk.bytes,
            }));
        }
        return view;
    }

    private async recordAudit(
        action: 'node.desktop.recording.start' | 'node.desktop.recording.stop',
        live: LiveRecording,
        extra: Record<string, unknown>,
    ): Promise<void> {
        await this.audit?.tryRecord({
            action,
            actorUserId: live.actorUserId,
            ownerUserId: live.ownerUserId,
            nodeId: live.nodeId,
            details: {
                family: 'desktop',
                target: live.viewId,
                source: 'desktop',
                requestedBy: `system:desktop-recording`,
                confirmationClass: 'plain',
                ...extra,
            },
        });
    }
}

/**
 * The newer index plus this writer's chunks it does not have yet, in time
 * order, numbered again (the player asks for chunks by number).
 */
function mergeIndexes(newer: RecordingIndex, mine: RecordingIndex): RecordingIndex {
    const keys = new Set(newer.chunks.map((chunk) => chunk.key));
    const chunks = [...newer.chunks, ...mine.chunks.filter((chunk) => !keys.has(chunk.key))]
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
        .map((chunk, seq) => ({ ...chunk, seq }));
    return { ...newer, chunks };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
