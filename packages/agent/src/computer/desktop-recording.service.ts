import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';
import {
    decodeDesktopRecordingChunk,
    encodeDesktopRecordingChunk,
    fleetDesktopRecordingRetentionDays,
    isFleetDesktopRecordingStopReason,
    FLEET_DESKTOP_RECORDING_CHUNK_MS,
    FLEET_DESKTOP_RECORDING_KEYFRAME_EVERY_MS,
    FLEET_DESKTOP_RECORDING_MAX_BYTES,
    FLEET_DESKTOP_RECORDING_MAX_MS,
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
 * player, deleted by its owner or by the nightly sweep.
 *
 * What is recorded is what the view received (the platform taps the viewer
 * gateway's node → viewer frames, never the controller's input): keyframes at
 * most one a second (FR-50) and the changed tiles between kept keyframes,
 * in 60-second chunks (`EWR1` containers) written through the configured
 * storage plugin ({@link DESKTOP_RECORDING_STORAGE}). Tiles that arrive while
 * no keyframe is kept are dropped until the next kept keyframe, so a replay
 * never paints a tile over the wrong picture.
 *
 * The view's `computer_sessions` row carries the recording (`recordingRef` =
 * the storage key of the recording's index object, never shown; bytes,
 * duration, expiry, why it stopped, `recorded`). The index lists the chunk
 * keys, rewritten after every chunk, so a crash loses at most one minute.
 *
 * Caps (FR-50): 200 MB or 4 hours stops the recording (`size-cap` /
 * `time-cap`) and the view goes on. A storage failure stops it
 * `storage-failed` and the view goes on (FR-55). Every start, stop and delete
 * is audited (`node.desktop.recording.*`).
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

/** Most rows one sweep pass reads. */
export const DESKTOP_RECORDING_SWEEP_BATCH = 100;

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
    index: RecordingIndex;
    indexKey: string | null;
    entries: FleetDesktopRecordingEntry[];
    bufferedBytes: number;
    chunkStartMs: number;
    storedBytes: number;
    lastKeyframeMs: number;
    /** False until a keyframe is kept, and again after any picture is dropped. */
    tilesFollow: boolean;
    flushing: Promise<void>;
    stopped: boolean;
}

export interface DesktopRecordingStart {
    viewId: string;
    nodeId: string;
    ownerUserId: string;
    /** Who the view belongs to (audited as the actor of the start). */
    actorUserId: string;
    trigger: FleetDesktopRecordingTrigger;
}

@Injectable()
export class DesktopRecordingService implements OnApplicationShutdown {
    private readonly logger = new Logger(DesktopRecordingService.name);
    private readonly live = new Map<string, LiveRecording>();
    /** Why a view's recording could not start or stopped on a failure (this replica; the row says it too). */
    private readonly failures = new Map<string, string>();

    constructor(
        private readonly sessions: ComputerSessionRepository,
        private readonly nodes: FleetNodeRepository,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() @Inject(DESKTOP_RECORDING_STORAGE) private readonly storage?: DesktopRecordingStoragePort | null,
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

    /** A shutting-down replica writes what it buffered (at most a minute is ever at stake). */
    async onApplicationShutdown(): Promise<void> {
        await this.stopAll('view-ended').catch(() => undefined);
    }

    /**
     * Start recording a view (idempotent). A view recorded before on another
     * replica continues its recording (the index is read back). Answers false
     * when it cannot record — no storage — after writing why on the row.
     */
    async start(input: DesktopRecordingStart): Promise<boolean> {
        if (this.isRecording(input.viewId)) return true;
        if (!this.storage) {
            this.failures.set(input.viewId, 'storage-unavailable');
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
            const previous = await this.readIndex(row.recordingRef);
            if (previous) {
                index = previous;
                storedBytes = Number(row.recordingBytes ?? 0) || 0;
            }
        }
        const startedAtMs = Date.parse(index.startedAt);
        const live: LiveRecording = {
            viewId: input.viewId,
            nodeId: input.nodeId,
            ownerUserId: input.ownerUserId,
            actorUserId: input.actorUserId,
            trigger: input.trigger,
            startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : now,
            index,
            indexKey: row.recordingRef ?? null,
            entries: [],
            bufferedBytes: 0,
            chunkStartMs: now,
            storedBytes,
            lastKeyframeMs: -Infinity,
            tilesFollow: false,
            flushing: Promise.resolve(),
            stopped: false,
        };
        if (now - live.startedAtMs >= FLEET_DESKTOP_RECORDING_MAX_MS || storedBytes >= FLEET_DESKTOP_RECORDING_MAX_BYTES) {
            return false;
        }
        this.live.set(input.viewId, live);
        this.failures.delete(input.viewId);
        await this.recordAudit('node.desktop.recording.start', live, { outcome: 'started', trigger: input.trigger });
        return true;
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
        if (live.storedBytes + live.bufferedBytes + payload.byteLength + 9 > FLEET_DESKTOP_RECORDING_MAX_BYTES) {
            void this.stop(viewId, 'size-cap');
            return;
        }
        // A minute of pictures is one chunk: this picture starts the next one.
        if (live.entries.length > 0 && now - live.chunkStartMs >= FLEET_DESKTOP_RECORDING_CHUNK_MS) {
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

    /** Stop recording a view: write what is buffered, the index, and the row. Idempotent. */
    async stop(viewId: string, reason: FleetDesktopRecordingStopReason): Promise<void> {
        const live = this.live.get(viewId);
        if (!live || live.stopped) return;
        live.stopped = true;
        this.queueFlush(live);
        await live.flushing;
        this.live.delete(viewId);
        const endedAt = new Date(this.now());
        const node = await this.nodes.findById(live.nodeId).catch(() => null);
        const retentionDays = fleetDesktopRecordingRetentionDays(node?.recordingRetentionDays);
        const durationMs = Math.max(0, endedAt.getTime() - live.startedAtMs);
        const patch: Partial<ComputerSession> = {
            recordingDurationMs: durationMs,
            recordingBytes: live.storedBytes,
            recordingExpiresAt: new Date(endedAt.getTime() + retentionDays * 86_400_000),
            recordingStoppedReason: reason,
        };
        if (live.indexKey) {
            patch.recordingRef = live.indexKey;
            patch.recorded = true;
        }
        await this.sessions.setRecording(viewId, patch).catch((error: unknown) => {
            this.logger.warn(`desktop recording ${viewId}: row not updated: ${message(error)}`);
        });
        await this.recordAudit('node.desktop.recording.stop', live, {
            outcome: 'stopped',
            stoppedReason: reason,
            durationMs,
            bytes: live.storedBytes,
        });
    }

    /** Stop every recording of this replica (shutdown). */
    async stopAll(reason: FleetDesktopRecordingStopReason): Promise<void> {
        await Promise.all([...this.live.keys()].map((viewId) => this.stop(viewId, reason)));
    }

    // ─── Reading (the player) ───────────────────────────────────────────────

    /** The recordings of one computer, newest first (rows that still have one). */
    async list(nodeId: string, nodeName: string): Promise<FleetDesktopRecordingView[]> {
        const rows = await this.sessions.findDesktopRecordingsForNode(nodeId);
        return rows.map((row) => this.viewOf(row, nodeName, null));
    }

    /** One recording with its chunk list (keys never leave the platform). */
    async read(viewId: string, nodeId: string, nodeName: string): Promise<FleetDesktopRecordingView | null> {
        const row = await this.sessions.findById(viewId);
        if (!row || row.nodeId !== nodeId || row.source !== 'desktop' || !row.recordingRef) return null;
        const index = await this.readIndex(row.recordingRef);
        return this.viewOf(row, nodeName, index);
    }

    /** One chunk's bytes, or null. */
    async chunk(viewId: string, nodeId: string, seq: number): Promise<Uint8Array | null> {
        const row = await this.sessions.findById(viewId);
        if (!row || row.nodeId !== nodeId || row.source !== 'desktop' || !row.recordingRef || !this.storage) return null;
        const index = await this.readIndex(row.recordingRef);
        const entry = index?.chunks.find((chunk) => chunk.seq === seq);
        if (!entry) return null;
        try {
            const { buffer } = await this.storage.getObject(entry.key);
            const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            return decodeDesktopRecordingChunk(bytes) ? bytes : null;
        } catch {
            return null;
        }
    }

    /**
     * Delete a recording now (the owner's "Delete now", or the sweep): every
     * object first, the row's recording fields second — a failed object
     * delete leaves the row, so the next sweep tries again. True when gone.
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
     * recording past its expiry is deleted (object first, row second). Nothing
     * is deleted on read. Returns what it did.
     */
    async sweepExpired(): Promise<{ deleted: number; failed: number }> {
        const rows = await this.sessions.findExpiredDesktopRecordings(new Date(this.now()), DESKTOP_RECORDING_SWEEP_BATCH);
        let deleted = 0;
        let failed = 0;
        for (const row of rows) {
            try {
                if (await this.remove(row.id, null)) deleted += 1;
                else failed += 1;
            } catch (error) {
                failed += 1;
                this.logger.warn(`desktop recording ${row.id}: not swept: ${message(error)}`);
            }
        }
        return { deleted, failed };
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /** Hand the buffered pictures to the writer as one chunk (in order, one write at a time). */
    private queueFlush(live: LiveRecording): void {
        if (live.entries.length === 0) return;
        const batch = live.entries;
        live.entries = [];
        live.bufferedBytes = 0;
        live.flushing = live.flushing.then(() => this.flush(live, batch)).catch(() => undefined);
    }

    /** Write one chunk, then the index, then the row. A failure stops the recording. */
    private async flush(live: LiveRecording, entries: FleetDesktopRecordingEntry[]): Promise<void> {
        if (entries.length === 0) return;
        const startMs = entries[0].tMs;
        const endMs = entries[entries.length - 1].tMs;
        const storage = this.storage;
        const bytes = encodeDesktopRecordingChunk(entries);
        if (!storage || !bytes) {
            await this.failed(live, 'the chunk could not be encoded');
            return;
        }
        try {
            const seq = live.index.chunks.length;
            const put = await storage.putObject({
                buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
                filename: `desktop-recording-${live.viewId}-${seq}.ewrec`,
                mimeType: 'application/octet-stream',
                size: bytes.byteLength,
                ownerId: live.ownerUserId,
            });
            live.index.chunks.push({ seq, key: put.key, startMs, endMs, bytes: bytes.byteLength });
            live.storedBytes += bytes.byteLength;
            const indexBytes = Buffer.from(JSON.stringify(live.index), 'utf8');
            const written = await storage.putObject({
                buffer: indexBytes,
                filename: `desktop-recording-${live.viewId}-index.json`,
                mimeType: 'application/json',
                size: indexBytes.byteLength,
                ownerId: live.ownerUserId,
            });
            const previous = live.indexKey;
            live.indexKey = written.key;
            await this.sessions.setRecording(live.viewId, {
                recordingRef: written.key,
                recordingBytes: live.storedBytes,
                recordingDurationMs: Math.max(0, endMs),
                recorded: true,
            });
            if (previous && previous !== written.key) await storage.deleteObject(previous).catch(() => undefined);
        } catch (error) {
            await this.failed(live, message(error));
        }
    }

    /** FR-55: storage failed — the recording stops, the view goes on, the row says why. */
    private async failed(live: LiveRecording, why: string): Promise<void> {
        this.logger.warn(`desktop recording ${live.viewId} stopped: ${why}`);
        this.failures.set(live.viewId, 'storage-failed');
        if (live.stopped) return;
        live.stopped = true;
        live.entries = [];
        this.live.delete(live.viewId);
        await this.sessions
            .setRecording(live.viewId, {
                recordingStoppedReason: 'storage-failed',
                recordingSkippedReason: 'storage-unavailable',
                ...(live.indexKey ? { recordingRef: live.indexKey, recorded: true } : {}),
            })
            .catch(() => undefined);
        await this.recordAudit('node.desktop.recording.stop', live, {
            outcome: 'failed',
            stoppedReason: 'storage-failed',
        });
    }

    private async markSkipped(viewId: string, reason: string): Promise<void> {
        await this.sessions.setRecording(viewId, { recordingSkippedReason: reason }).catch(() => undefined);
    }

    private async readIndex(key: string): Promise<RecordingIndex | null> {
        if (!this.storage) return null;
        try {
            const { buffer } = await this.storage.getObject(key);
            const value = JSON.parse(buffer.toString('utf8')) as Partial<RecordingIndex>;
            if (value?.schemaVersion !== 1 || !Array.isArray(value.chunks) || typeof value.startedAt !== 'string') {
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

    /** Every object of a recording (chunks, then the index). False when any delete failed. */
    private async deleteObjects(indexKey: string): Promise<boolean> {
        if (!this.storage) return false;
        const index = await this.readIndex(indexKey);
        try {
            for (const chunk of index?.chunks ?? []) await this.storage.deleteObject(chunk.key);
            await this.storage.deleteObject(indexKey);
            return true;
        } catch (error) {
            this.logger.warn(`desktop recording objects not deleted: ${message(error)}`);
            return false;
        }
    }

    private viewOf(row: ComputerSession, nodeName: string, index: RecordingIndex | null): FleetDesktopRecordingView {
        const startedAtMs = index ? Date.parse(index.startedAt) : new Date(row.startedAt ?? row.createdAt).getTime();
        const view: FleetDesktopRecordingView = {
            viewId: row.id,
            nodeId: row.nodeId,
            nodeName,
            source: 'desktop',
            displayId: row.displayId ?? null,
            quality: row.quality,
            openedByUserId: row.openedByUserId,
            trigger: index?.trigger ?? 'control',
            startedAt: new Date(Number.isFinite(startedAtMs) ? startedAtMs : Date.now()).toISOString(),
            endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
            durationMs: Number(row.recordingDurationMs ?? 0) || 0,
            bytes: Number(row.recordingBytes ?? 0) || 0,
            expiresAt: row.recordingExpiresAt ? new Date(row.recordingExpiresAt).toISOString() : null,
            stoppedReason: isFleetDesktopRecordingStopReason(row.recordingStoppedReason) ? row.recordingStoppedReason : null,
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

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
