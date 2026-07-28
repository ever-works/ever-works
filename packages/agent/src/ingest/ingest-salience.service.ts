import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { config } from '../config';

/** Verdict for one envelope. */
export interface SalienceVerdict {
    /** 0–100. Higher = more worth a human's attention. */
    score: number;
    /** False when the envelope should be dropped before insert. */
    salient: boolean;
    /** Short machine-readable reason when `salient` is false. */
    reason?: 'muted-kind' | 'muted-actor' | 'below-min-score';
}

/**
 * Neutral score every envelope starts from. Signals push it up or down;
 * the operator's `INGEST_SALIENCE_MIN_SCORE` decides where the cut is.
 */
export const SALIENCE_BASE_SCORE = 50;

/**
 * Kind fragments that mark an event as high-signal — the things a user
 * connected the source FOR. Matched as a substring of the lowercased
 * `kind`, so `github.pull_request.merged` matches `pull_request`.
 */
export const SALIENT_KIND_FRAGMENTS: readonly string[] = [
    'issue',
    'pull_request',
    'pull-request',
    'merge',
    'review',
    'incident',
    'alert',
    'deploy',
    'release',
    'recording',
    'meeting',
    'decision',
    'mention',
];

/**
 * Kind fragments that mark an event as low-signal chatter — the traffic
 * that drowns a feed without telling anyone anything.
 */
export const NOISY_KIND_FRAGMENTS: readonly string[] = [
    'heartbeat',
    'ping',
    'presence',
    'typing',
    'reaction',
    'view',
    'visit',
    'watch',
    'star',
    'poll',
    'sync',
];

/** Actor-name fragments that read as "an automation did this". */
export const BOT_ACTOR_FRAGMENTS: readonly string[] = [
    'bot',
    'webhook',
    'automation',
    'no-reply',
    'noreply',
];

/**
 * Event-ingest salience filter (audit item (k)).
 *
 * ## Why
 *
 * The spine wrote EVERY envelope a connector produced. A chatty source —
 * reaction events, presence changes, bot heartbeats, a CI account
 * commenting on every push — could bury the handful of events the user
 * actually connected the source for, in the feed, in Activity, and in
 * agent Memory (each ingested row fans out to all three).
 *
 * ## Contract
 *
 * **Off by default.** `INGEST_SALIENCE_MIN_SCORE` defaults to `0` and
 * both mute lists default to empty, so an unconfigured deployment keeps
 * exactly the pre-filter behaviour — nothing is dropped. That is the
 * deliberate safe default: silently discarding a customer's events is a
 * far worse failure than a noisy feed, so the filter only ever bites
 * when an operator asked for it.
 *
 * Scoring is a transparent, deterministic rubric (no model call, no
 * network, no per-event state) so a dropped event is always explainable
 * and a spec can pin the exact numbers.
 *
 * Ordering: mutes are absolute and evaluated first (an operator naming a
 * kind or an actor means it, regardless of score), then the score gate.
 *
 * Blast radius, stated plainly: the gate sits in `EventIngestService`
 * `ingest()`, which is the ONE door every path uses (pull cron, the
 * `POST /api/ingest/events` push surface, the Slack and GitHub inbound
 * bridges). A filtered envelope therefore never becomes a row, so
 * anything keyed off `inserted > 0` — the Slack chat reply, the GitHub PR
 * review trigger — does not fire for it either. That is the intended
 * reading of "mute this kind", and it is why the filter is opt-in.
 */
@Injectable()
export class IngestSalienceService {
    private readonly logger = new Logger(IngestSalienceService.name);

    /** True when at least one knob is configured. */
    isEnabled(): boolean {
        return config.ingest.isSalienceFilterEnabled();
    }

    /**
     * Score one envelope on the 0–100 rubric. Pure: same envelope in,
     * same score out, independent of configuration.
     */
    score(envelope: IngestedEventEnvelope): number {
        let score = SALIENCE_BASE_SCORE;

        const kind = (envelope.kind ?? '').toLowerCase();
        if (SALIENT_KIND_FRAGMENTS.some((fragment) => kind.includes(fragment))) score += 20;
        if (NOISY_KIND_FRAGMENTS.some((fragment) => kind.includes(fragment))) score -= 30;

        // A titled subject is the difference between "someone changed
        // something" and a row a human can act on.
        const title = envelope.subject?.title;
        if (typeof title === 'string' && title.trim().length > 0) score += 15;

        // Without a deep link the feed row is a dead end.
        if (typeof envelope.sourceUrl === 'string' && envelope.sourceUrl.length > 0) score += 10;

        const actorName = envelope.actor?.name;
        if (typeof actorName === 'string' && actorName.trim().length > 0) {
            score += 5;
            const lowered = actorName.toLowerCase();
            if (BOT_ACTOR_FRAGMENTS.some((fragment) => lowered.includes(fragment))) score -= 20;
        }

        // Nothing to read AND nowhere to go AND no details: the row can
        // only ever say "an event happened".
        const payloadKeys = envelope.payload ? Object.keys(envelope.payload).length : 0;
        if (!title && !envelope.sourceUrl && payloadKeys === 0) score -= 20;

        return Math.max(0, Math.min(100, score));
    }

    /** Score + verdict for one envelope under the current configuration. */
    evaluate(envelope: IngestedEventEnvelope): SalienceVerdict {
        const score = this.score(envelope);

        const kind = (envelope.kind ?? '').toLowerCase();
        if (config.ingest.getSalienceMutedKinds().some((muted) => matchesKind(kind, muted))) {
            return { score, salient: false, reason: 'muted-kind' };
        }

        const actorName = (envelope.actor?.name ?? '').toLowerCase();
        if (
            actorName.length > 0 &&
            config.ingest.getSalienceMutedActors().some((muted) => actorName.includes(muted))
        ) {
            return { score, salient: false, reason: 'muted-actor' };
        }

        const min = config.ingest.getSalienceMinScore();
        if (min > 0 && score < min) {
            return { score, salient: false, reason: 'below-min-score' };
        }

        return { score, salient: true };
    }

    /**
     * Convenience wrapper used by the ingest hot path. Returns `true`
     * when the envelope should be stored. Logs at debug on a drop so an
     * operator tuning the knobs can see what the filter is eating.
     */
    isSalient(envelope: IngestedEventEnvelope): boolean {
        const verdict = this.evaluate(envelope);
        if (!verdict.salient) {
            this.logger.debug(
                `Salience filter dropped ${envelope.source}/${envelope.sourceEventId} ` +
                    `(${envelope.kind}) — ${verdict.reason}, score ${verdict.score}`,
            );
        }
        return verdict.salient;
    }
}

/**
 * Mute-list match. Exact by default; a trailing `.*` (or a bare `*`)
 * makes it a prefix match so `slack.*` mutes a whole source.
 */
function matchesKind(kind: string, muted: string): boolean {
    if (muted === '*') return true;
    if (muted.endsWith('*')) {
        return kind.startsWith(muted.slice(0, -1));
    }
    return kind === muted;
}
