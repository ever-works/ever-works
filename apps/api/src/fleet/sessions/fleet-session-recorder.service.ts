import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TerminalTranscriptService } from '@ever-works/agent/agents';
import {
    FleetSessionService,
    type FleetSessionRecorderPort,
    type FleetSessionRecordingTarget,
} from '@ever-works/agent/fleet';
import { FLEET_LINK_FRAME_KINDS, fleetSessionConsentFor, parseFleetSessionNotice } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkRegistry } from '../../fleet-link/fleet-link.registry';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';

/** Flush what was recorded at least this often… */
const FLUSH_MS = 1_000;
/** …or as soon as this much is waiting. */
const FLUSH_BYTES = 64 * 1024;
/** Re-check which recorded sessions this replica should be recording. */
const SWEEP_MS = 30_000;
/** Most frames one recorder holds before a flush catches up; past it, the oldest go. */
const MAX_PENDING_FRAMES = 4_096;

interface Recording {
    target: FleetSessionRecordingTarget;
    channel: FleetLinkChannel | null;
    opening: boolean;
    stopped: boolean;
    seq: number;
    pending: Array<{ seq: number; data: Uint8Array }>;
    pendingBytes: number;
    timer: NodeJS.Timeout | null;
    flushing: Promise<void> | null;
}

/**
 * Sessions on computers (FL-04 P3, CONTRACTS R-9, AW-11 P3) — the recorder:
 * `FLEET_SESSION_RECORDER` for the session service.
 *
 * For each live session being recorded it opens ONE watch-only `session`
 * channel to the machine through the node link (FL-02: `mode: 'viewer'`, a
 * system caller, never state-changing — the kill switch and every consent
 * check of the link apply as to any other channel), asks the node to attach
 * (`session.attach`, a watcher's size is ignored) and stores every `DATA`
 * frame through `TerminalTranscriptService.persistSessionFrames` — redacted,
 * batched (1 s or 64 KiB), sequence-numbered after what is already stored, so
 * a re-attach (the link came back, this replica restarted) appends rather
 * than overwrites. A `replay` notice (the node re-attached) is stored too:
 * the player clears the terminal there, exactly as a live viewer does.
 *
 * Only the replica that HOLDS a node's link records its sessions (one
 * recorder per session, never two writing the same sequence); a session the
 * request landed on another replica for is picked up by the holder's 30 s
 * sweep. A storage failure stops the recording (`recordingFailed` → `off`,
 * one audit row) and never touches the live view. Payloads are never logged.
 *
 * `FleetSessionService` is resolved lazily through `ModuleRef`, never
 * injected: the session service consumes THIS provider (the
 * `FLEET_SESSION_RECORDER` port), so a constructor dependency back on it would
 * be a provider cycle and a boot crash.
 */
@Injectable()
export class FleetSessionRecorderService implements FleetSessionRecorderPort, OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger(FleetSessionRecorderService.name);
    private readonly recordings = new Map<string, Recording>();
    private sweeper: NodeJS.Timeout | null = null;

    constructor(
        private readonly moduleRef: ModuleRef,
        private readonly transcripts: TerminalTranscriptService,
        private readonly links: FleetLinkService,
        private readonly registry: FleetLinkRegistry,
    ) {}

    /** The session service, or null while it cannot be resolved (it is never absent in the API). */
    private sessions(): FleetSessionService | null {
        try {
            return this.moduleRef.get(FleetSessionService, { strict: false });
        } catch {
            return null;
        }
    }

    onModuleInit(): void {
        this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
        this.sweeper.unref?.();
    }

    onApplicationShutdown(): void {
        if (this.sweeper) clearInterval(this.sweeper);
        for (const id of [...this.recordings.keys()]) this.stop(id);
    }

    // ─── The port ──────────────────────────────────────────────────────────

    ensure(target: FleetSessionRecordingTarget): void {
        if (!config.fleet.isSessionsEnabled()) return;
        // The replica holding the link records; any other leaves it to the holder's sweep.
        if (!this.registry.isConnected(target.nodeId)) return;
        const existing = this.recordings.get(target.id);
        if (existing && !existing.stopped && (existing.channel?.isOpen || existing.opening)) return;
        const recording: Recording = existing && !existing.stopped
            ? existing
            : {
                  target,
                  channel: null,
                  opening: false,
                  stopped: false,
                  seq: -1,
                  pending: [],
                  pendingBytes: 0,
                  timer: null,
                  flushing: null,
              };
        this.recordings.set(target.id, recording);
        void this.open(recording);
    }

    stop(sessionId: string): void {
        const recording = this.recordings.get(sessionId);
        if (!recording) return;
        recording.stopped = true;
        this.recordings.delete(sessionId);
        if (recording.timer) clearTimeout(recording.timer);
        recording.timer = null;
        void this.flush(recording);
        const channel = recording.channel;
        recording.channel = null;
        if (channel && !channel.isClosed) {
            try {
                channel.close('normal');
            } catch {
                // already gone
            }
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private async open(recording: Recording): Promise<void> {
        if (recording.opening || recording.stopped) return;
        recording.opening = true;
        const { target } = recording;
        try {
            if (recording.seq < 0) {
                const stats = await this.transcripts.sessionRecordingStats(target.id);
                recording.seq = stats.maxSeq ?? -1;
            }
            const channel = await this.links.openChannel({
                nodeId: target.nodeId,
                family: 'session',
                params: { sessionId: target.daemonSessionId, mode: 'viewer', kind: target.kind },
                caller: { kind: 'system', job: 'session-recorder' },
                requirement: {
                    consent: fleetSessionConsentFor(target.kind),
                    actionFamily: 'sessions',
                    stateChanging: false,
                    target: target.id,
                },
                events: {
                    binary: (kind, payload) => {
                        if (kind === FLEET_LINK_FRAME_KINDS.DATA) this.capture(recording, payload);
                    },
                    json: (message) => {
                        // The node re-attached: store the restart so the player clears there too.
                        if (parseFleetSessionNotice(message)?.notice === 'replay') {
                            this.capture(recording, new TextEncoder().encode('\u001bc'));
                        }
                    },
                    close: () => {
                        if (recording.channel === channel) recording.channel = null;
                        void this.flush(recording);
                    },
                },
            });
            if (recording.stopped) {
                channel.close('normal');
                return;
            }
            recording.channel = channel;
            const reply = await channel.request('session.attach', {}, { timeoutMs: 20_000 });
            if ('error' in reply) {
                this.logger.debug(`session ${target.id}: recorder attach refused: ${reply.error.code}`);
                channel.close('normal');
                recording.channel = null;
            }
        } catch (error) {
            this.logger.debug(
                `session ${target.id}: recorder not attached: ${error instanceof Error ? error.message : String(error)}`,
            );
            recording.channel = null;
        } finally {
            recording.opening = false;
        }
    }

    private capture(recording: Recording, payload: Uint8Array): void {
        if (recording.stopped || payload.byteLength === 0) return;
        recording.seq += 1;
        // Copied: the payload's buffer belongs to the link's frame decoder.
        recording.pending.push({ seq: recording.seq, data: new Uint8Array(payload) });
        recording.pendingBytes += payload.byteLength;
        if (recording.pending.length > MAX_PENDING_FRAMES) {
            const dropped = recording.pending.shift();
            if (dropped) recording.pendingBytes -= dropped.data.byteLength;
        }
        if (recording.pendingBytes >= FLUSH_BYTES) {
            void this.flush(recording);
            return;
        }
        if (!recording.timer) {
            recording.timer = setTimeout(() => {
                recording.timer = null;
                void this.flush(recording);
            }, FLUSH_MS);
            recording.timer.unref?.();
        }
    }

    private async flush(recording: Recording): Promise<void> {
        if (recording.flushing) await recording.flushing.catch(() => undefined);
        if (recording.pending.length === 0) return;
        const batch = recording.pending.splice(0);
        recording.pendingBytes = 0;
        recording.flushing = (async () => {
            const stored = await this.transcripts.persistSessionFrames(recording.target.id, batch);
            if (stored < 0) {
                // Storage is down: stop recording (state off, one audit row); the live view goes on.
                this.stop(recording.target.id);
                await this.sessions()?.recordingFailed(recording.target.id);
            }
        })();
        try {
            await recording.flushing;
        } finally {
            recording.flushing = null;
        }
    }

    /** Record every live recorded session whose node this replica holds (picks up starts made elsewhere). */
    private async sweep(): Promise<void> {
        if (!config.fleet.isSessionsEnabled()) return;
        try {
            const nodeIds = this.registry.connectedNodeIds();
            if (nodeIds.length === 0) return;
            const sessions = this.sessions();
            if (!sessions) return;
            for (const row of await sessions.liveRecordingFor(nodeIds)) {
                this.ensure({ id: row.id, nodeId: row.nodeId, daemonSessionId: row.daemonSessionId, kind: row.kind });
            }
        } catch (error) {
            this.logger.debug(`recorder sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
