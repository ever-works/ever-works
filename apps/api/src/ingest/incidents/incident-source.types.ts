import { randomUUID } from 'node:crypto';
import type { IngestedEventEnvelope, IngestedEventWorkHint } from '@ever-works/contracts';
import {
    INGESTED_EVENT_ACTOR_MAX_CHARS,
    INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS,
    INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS,
    INGESTED_EVENT_TITLE_MAX_CHARS,
    capped,
    isoOrNow,
} from '../ingest-envelope.util';

/**
 * Incident intake (self-build program note §6, findings R2/R23).
 *
 * An **incident** is "something broke and somebody should look": a
 * Sentry issue alert, a Dependabot security alert, a CI job that keeps
 * flaking. They come from different vendors with different payloads,
 * but a trigger author wants ONE thing to match on — so every incident
 * source normalizes into the same `kind: 'incident'` envelope with the
 * same payload block. A trigger with `eventMatcher: { kind: 'incident' }`
 * matches all of them; `source` narrows to one vendor.
 *
 * ## Adding a source
 *
 * Implement {@link IncidentSource} for the vendor's raw input, build the
 * envelope with {@link buildIncidentEnvelope} (which enforces the
 * `ingested_events` column caps), and plug it into whichever receiver
 * verifies that vendor's signature:
 *
 *   * `DependabotIncidentSource` rides the existing GitHub receiver —
 *     same App / install signature path, `dependabot_alert` deliveries;
 *   * `SentryIncidentSource` has its own receiver
 *     (`POST /api/ingest/sentry/events`, `Sentry-Hook-Signature`);
 *   * a **CI-flake** source is a documented seam: implement
 *     `IncidentSource<CiRunPayload>` over the CI provider's run payload
 *     (GitHub `workflow_run` / `check_run` deliveries verify through the
 *     GitHub receiver already) and register it beside Dependabot in
 *     `GitHubIssueIntakeService`. No code path exists for it yet.
 *
 * The triage filer (`triage/triage-task-filer.service.ts`) consumes the
 * `incident` kind and files ONE Task per `(source, externalId)`.
 */

/** The one cross-vendor incident kind — what triggers match on. */
export const INCIDENT_EVENT_KIND = 'incident';

/** Vendors an incident can come from. `ci-flake` is the documented seam. */
export type IncidentProvider = 'sentry' | 'dependabot' | 'ci-flake';

/**
 * The payload block every incident envelope carries. Vendor-specific
 * extras may ride alongside (the index signature), but these keys are
 * what the triage Task body and the trigger templates rely on.
 */
export interface IncidentPayload extends Record<string, unknown> {
    provider: IncidentProvider;
    /** The incident's stable id in the vendor system (dedup key with `source`). */
    externalId: string;
    title: string;
    /** Deep link to the incident (issue page, alert page). */
    url?: string;
    /** Where it blew up — function / module / package, vendor vocabulary. */
    culprit?: string;
    /** Severity in the vendor's vocabulary (`fatal`, `error`, `high`, …). */
    level?: string;
    /** Release / version the incident was last seen in. */
    release?: string;
    environment?: string;
    /** Project slug / name in the vendor system. */
    project?: string;
    projectId?: string;
    /** Vendor lifecycle state (`unresolved`, `open`, `fixed`, …). */
    status?: string;
    /** The lifecycle action that produced this event (`created`, `resolved`, …). */
    action?: string;
}

/**
 * One incident source: turns a vendor's raw webhook input into the
 * shared incident envelope, or `null` when the input is not an incident
 * worth filing (unknown action, missing identity, …).
 */
export interface IncidentSource<TInput> {
    readonly provider: IncidentProvider;
    /** The `ingested_events.source` namespace this vendor lands under. */
    readonly source: string;
    normalize(input: TInput): IngestedEventEnvelope | null;
}

/** Inputs for {@link buildIncidentEnvelope}. */
export interface BuildIncidentEnvelopeInput {
    readonly source: string;
    /** Revision-bearing id — repeated alerts land as NEW events, exact redeliveries dedupe. */
    readonly sourceEventId: string;
    readonly occurredAt: string | number | null | undefined;
    readonly actor?: string;
    /**
     * `subject.type`. Defaults to `issue` so the drain's external-issue
     * link touch keeps working; Dependabot uses `dependabot_alert`.
     */
    readonly subjectType?: string;
    readonly sourceUrl?: string;
    readonly workHint?: IngestedEventWorkHint;
    readonly payload: IncidentPayload;
}

/**
 * Build a `kind: 'incident'` envelope with every `ingested_events`
 * column width enforced. The subject's `externalId` and `title` come
 * from the payload so the two can never disagree.
 */
export function buildIncidentEnvelope(input: BuildIncidentEnvelopeInput): IngestedEventEnvelope {
    const { payload } = input;
    return {
        id: randomUUID(),
        source: input.source,
        sourceEventId: capped(input.sourceEventId, INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS),
        kind: INCIDENT_EVENT_KIND,
        occurredAt: isoOrNow(input.occurredAt),
        ...(input.actor
            ? { actor: { name: capped(input.actor, INGESTED_EVENT_ACTOR_MAX_CHARS) } }
            : {}),
        subject: {
            type: input.subjectType ?? 'issue',
            externalId: capped(payload.externalId, INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS),
            title: capped(payload.title, INGESTED_EVENT_TITLE_MAX_CHARS),
        },
        ...(input.workHint ? { workHint: input.workHint } : {}),
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        payload: {
            ...payload,
            title: capped(payload.title, INGESTED_EVENT_TITLE_MAX_CHARS),
        },
    };
}
