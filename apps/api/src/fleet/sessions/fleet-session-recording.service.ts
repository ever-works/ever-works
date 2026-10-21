import { Injectable } from '@nestjs/common';
import { TerminalTranscriptService } from '@ever-works/agent/agents';
import {
    FleetAuditService,
    FleetNodeRepository,
    FleetSessionService,
    type FleetSessionActor,
} from '@ever-works/agent/fleet';
import {
    FLEET_SESSION_RECORDING_RETENTION_DAYS,
    type FleetSessionDriverSpan,
    type FleetSessionRecordingManifest,
    type FleetSessionRecordingPage,
} from '@ever-works/contracts';

/** Audit rows read for the driver spans of one recording. */
const SPAN_AUDIT_ROWS = 200;

/**
 * Sessions on computers (FL-04 P3, plan §5, CONTRACTS §11.2) — what
 * `GET /api/fleet/sessions/:id/recording` answers:
 *
 *  - without `from`: the manifest — the recording state, how many chunks are
 *    stored, how long they span, the driver spans on the timeline (from the
 *    `node.session.input` audit rows: who drove, from when to when — never a
 *    keystroke), and whether an ended recording was removed by retention;
 *  - with `from` (and `limit`): one page of chunks, oldest first, the text
 *    already redacted at write time.
 *
 * Authorization is the session service's (`get`: the `sessions` audience; a
 * stranger reads the 404 of an unknown id) before anything is read.
 */
@Injectable()
export class FleetSessionRecordingService {
    constructor(
        private readonly sessions: FleetSessionService,
        private readonly transcripts: TerminalTranscriptService,
        private readonly audit: FleetAuditService,
        private readonly nodes: FleetNodeRepository,
    ) {}

    async manifest(id: string, actor: FleetSessionActor): Promise<FleetSessionRecordingManifest> {
        const view = await this.sessions.get(id, actor);
        const stats = await this.transcripts.sessionRecordingStats(view.id);
        const durationMs =
            stats.firstAt && stats.lastAt ? Math.max(0, stats.lastAt.getTime() - stats.firstAt.getTime()) : 0;
        const node = await this.nodes.findById(view.nodeId);
        const driverSpans: FleetSessionDriverSpan[] = [];
        if (node) {
            for (const row of await this.audit.recentForOwnerNode(node.userId, node.id, SPAN_AUDIT_ROWS)) {
                const details = row.details ?? {};
                if (row.action !== 'node.session.input' || details.target !== view.id) continue;
                if (typeof details.from !== 'string' || typeof details.to !== 'string') continue;
                driverSpans.push({
                    userId: row.actorUserId,
                    requestedBy: typeof details.requestedBy === 'string' ? details.requestedBy : null,
                    from: details.from,
                    to: details.to,
                });
            }
            driverSpans.sort((a, b) => a.from.localeCompare(b.from));
        }
        return {
            state: view.recordingState,
            chunks: stats.count,
            durationMs,
            firstAt: stats.firstAt?.toISOString() ?? null,
            lastAt: stats.lastAt?.toISOString() ?? null,
            driverSpans,
            expired: view.recordingState === 'stored' && stats.count === 0 && isOlderThanRetention(view.endedAt),
            retentionDays: FLEET_SESSION_RECORDING_RETENTION_DAYS,
        };
    }

    async page(
        id: string,
        actor: FleetSessionActor,
        query: { from?: number; limit?: number },
    ): Promise<FleetSessionRecordingPage> {
        const view = await this.sessions.get(id, actor);
        return this.transcripts.getSessionRecordingPage(view.id, {
            ...(query.from !== undefined ? { fromSeq: query.from } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
        });
    }
}

function isOlderThanRetention(endedAt: string | null): boolean {
    if (!endedAt) return false;
    const at = Date.parse(endedAt);
    return Number.isFinite(at) && Date.now() - at > FLEET_SESSION_RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}
