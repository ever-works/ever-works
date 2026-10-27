import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    fleetSessionAttentionKey,
    isFleetSessionLive,
    parseFleetSessionAttention,
    parseFleetSessionLastEvidence,
    type FleetSessionAttention,
    type FleetSessionAttentionMessage,
    type FleetSessionState,
    type FleetSessionStatusMessage,
} from '@ever-works/contracts';
import type { FleetSession } from '../../entities/fleet-session.entity';
import { FleetSessionRepository } from './fleet-session.repository';
import {
    FLEET_SESSION_ATTENTION_SINK,
    type FleetSessionAttentionAnswer,
    type FleetSessionAttentionSink,
} from './fleet-session-attention.port';

/**
 * Session status (FL-05, CONTRACTS §4.2, §5, plan §1 `FleetSessionStateService`,
 * spec FR-12 … FR-19, U5) — the platform's writer of what a machine reports
 * about a session's STATUS: `session.status` (state, outcome, evidence, the
 * card's lines, what was injected) and `session.attention` (the open "needs
 * you" edge, or the unread `finished` marker).
 *
 * `FleetSessionService` (FL-04) stays the writer of the session's life —
 * start, end, rename, the node's process facts; this service writes only the
 * status columns, and only while the session is live (`updateIfLive`), so a
 * report can never resurrect an ended session.
 *
 * Reports are untrusted (the contract parsers already bounded them) and
 * idempotent: a `session.status` whose sequence is not newer than the row's
 * `lastEvidence.detail.seq` is ignored (a replay, a duplicate — U5); an
 * attention with the key the row already holds only refreshes its content
 * and keeps when it was raised and acknowledged (a key acknowledged once
 * never re-flags, §5.2). A shell is never `needs_you` or `done` (FR-19),
 * whatever a report claims. A report for a row that does not exist yet (an
 * owner session's row is written once the machine said the process runs)
 * is retried briefly. Never throws.
 *
 * P2 binds a {@link FleetSessionAttentionSink} — the Inbox item and Decision,
 * the "needs a look" row and the notification for an attention edge.
 */

/** How often, and how many times, a report for a row not written yet is retried. */
const EARLY_RETRY_MS = 2_000;
const EARLY_RETRIES = 5;

@Injectable()
export class FleetSessionStateService {
    private readonly logger = new Logger(FleetSessionStateService.name);
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly sessions: FleetSessionRepository,
        @Optional()
        @Inject(FLEET_SESSION_ATTENTION_SINK)
        private readonly sink?: FleetSessionAttentionSink,
    ) {}

    /** One `session.status` from a node (CONTRACTS §3.3). */
    async applyStatus(
        nodeId: string,
        message: FleetSessionStatusMessage,
        attempt = 0,
    ): Promise<void> {
        try {
            const row = await this.sessions.findByDaemonId(nodeId, message.sessionId);
            if (!row) {
                this.retryLater(attempt, () => this.applyStatus(nodeId, message, attempt + 1));
                return;
            }
            if (!isFleetSessionLive(row.state)) return;
            const stored = row.lastEvidence
                ? parseFleetSessionLastEvidence(row.lastEvidence)
                : null;
            if (stored && message.seq <= stored.detail.seq) return;
            if (
                row.provider === 'shell' &&
                (message.state === 'needs_you' || message.state === 'done')
            ) {
                this.logger.debug(
                    `node ${nodeId} reported a shell as ${message.state}; ignored (FR-19)`,
                );
                return;
            }
            const now = new Date(this.now());
            const patch: Partial<FleetSession> = {
                lastEvidence: message.lastEvidence,
                boundaryUntil: message.boundaryUntil ? new Date(message.boundaryUntil) : null,
                lastActivityAt: now,
            };
            if (message.hooks) patch.hooks = message.hooks;
            const state: FleetSessionState = message.state;
            if (state !== row.state) {
                patch.state = state;
                patch.stateChangedAt = now;
                if (row.state === 'starting' && !row.startedAt) patch.startedAt = now;
            }
            if ((message.outcome ?? null) !== (row.outcome ?? null))
                patch.outcome = message.outcome ?? null;
            await this.sessions.updateIfLive(row.id, patch);
        } catch (error) {
            this.logger.warn(
                `session.status for ${message.sessionId} on node ${nodeId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** One `session.attention` from a node (CONTRACTS §3.3, §5.2). */
    async applyAttention(
        nodeId: string,
        message: FleetSessionAttentionMessage,
        attempt = 0,
    ): Promise<void> {
        try {
            const row = await this.sessions.findByDaemonId(nodeId, message.sessionId);
            if (!row) {
                this.retryLater(attempt, () => this.applyAttention(nodeId, message, attempt + 1));
                return;
            }
            if (!isFleetSessionLive(row.state)) return;
            if (row.provider === 'shell' && message.attention) return;
            const current = row.attention ? parseFleetSessionAttention(row.attention) : null;
            const next = this.nextAttention(current, message.attention);
            if (next === current) return;
            if (JSON.stringify(next) === JSON.stringify(current)) return;
            const won = await this.sessions.updateIfLive(row.id, { attention: next });
            if (!won) return;
            await this.notifySink(row, current, next, message.finished === true);
        } catch (error) {
            this.logger.warn(
                `session.attention for ${message.sessionId} on node ${nodeId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Somebody answered through the platform (the card, the detail, the
     * Inbox, a tool, the CLI): the session service already cleared the row;
     * every other door closes now (FR-28: within 2 s everywhere).
     */
    async attentionAnswered(
        row: FleetSession,
        attention: FleetSessionAttention,
        answer: FleetSessionAttentionAnswer,
    ): Promise<void> {
        if (!this.sink) return;
        try {
            await this.sink.attentionCleared(row, attention, answer);
        } catch (error) {
            this.logger.warn(
                `session ${row.id}: answered attention not delivered: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * A session just ended (FL-04's end paths call this with the row before
     * and after): an open prompt expires with it (R-12 — never answered
     * automatically), and a session that ended with a failure raises the
     * `failed` notice (U14) — never for a shell, never for a person's or the
     * platform's own end (those are `cancelled`, not news). Never throws.
     */
    async sessionEnded(before: FleetSession, after: FleetSession): Promise<void> {
        try {
            const previous = before.attention ? parseFleetSessionAttention(before.attention) : null;
            if (
                previous &&
                previous.reason !== 'finished' &&
                previous.reason !== 'failed' &&
                this.sink
            ) {
                await this.sink.attentionCleared({ ...after, attention: null }, previous, null);
            }
            if (after.provider === 'shell' || after.outcome !== 'failure') return;
            const code = typeof after.exitCode === 'number' ? after.exitCode : null;
            const failed: FleetSessionAttention = {
                key: fleetSessionAttentionKey(after.id, 'failed', 'exit'),
                reason: 'failed',
                prompt: code !== null ? `exit code ${code}` : 'the session failed',
                options: [],
                raisedAt: new Date(this.now()).toISOString(),
                acknowledgedAt: null,
            };
            await this.sessions.update(after.id, { attention: failed });
            if (this.sink)
                await this.sink.attentionRaised({ ...after, attention: failed }, failed, {
                    finished: false,
                });
        } catch (error) {
            this.logger.warn(
                `session ${after.id}: end not delivered: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * The attention to store: the same key keeps when it was raised and
     * acknowledged (an acknowledged edge never re-flags); a new key replaces
     * the old one; null clears.
     */
    private nextAttention(
        current: FleetSessionAttention | null,
        reported: FleetSessionAttention | null,
    ): FleetSessionAttention | null {
        if (!reported) return null;
        if (current && current.key === reported.key) {
            return {
                ...reported,
                raisedAt: current.raisedAt,
                acknowledgedAt: current.acknowledgedAt,
            };
        }
        return { ...reported, acknowledgedAt: null };
    }

    private async notifySink(
        row: FleetSession,
        previous: FleetSessionAttention | null,
        next: FleetSessionAttention | null,
        finished: boolean,
    ): Promise<void> {
        if (!this.sink) return;
        try {
            if (previous && (!next || next.key !== previous.key)) {
                await this.sink.attentionCleared({ ...row, attention: next }, previous, null);
            }
            if (next && (!previous || previous.key !== next.key)) {
                await this.sink.attentionRaised({ ...row, attention: next }, next, { finished });
            }
        } catch (error) {
            this.logger.warn(
                `session ${row.id}: attention delivery failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private retryLater(attempt: number, retry: () => Promise<void>): void {
        if (attempt >= EARLY_RETRIES) return;
        const timer = setTimeout(() => void retry(), EARLY_RETRY_MS);
        timer.unref?.();
    }
}
