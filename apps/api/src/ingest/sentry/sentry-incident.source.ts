import { Injectable } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { httpsUrl, nonEmpty } from '../ingest-envelope.util';
import {
    buildIncidentEnvelope,
    type IncidentPayload,
    type IncidentSource,
} from '../incidents/incident-source.types';

/** `ingested_events.source` namespace for Sentry incidents. */
export const SENTRY_EVENT_SOURCE = 'sentry';

/**
 * `Sentry-Hook-Resource` values this source turns into incidents.
 *
 *  * `event_alert` — an issue alert rule fired for an event
 *    (`data.event` + `data.triggered_rule`);
 *  * `issue` — issue lifecycle (`created`, `resolved`, `unresolved`,
 *    `assigned`, `ignored`, `archived`, `unarchived`).
 *
 * `error` (every single error event — far too chatty), `comment`,
 * `metric_alert` and `installation` are NOT incidents; the receiver
 * handles `installation` itself and the rest are acknowledged and
 * dropped.
 */
export const SENTRY_INCIDENT_RESOURCES: readonly string[] = ['event_alert', 'issue'];

/**
 * Width of the bucket that repeated `event_alert` deliveries for ONE
 * Sentry issue collapse into, in milliseconds.
 *
 * A Sentry issue that is flapping alerts once per occurrence. Keying the
 * envelope on the individual `event_id` (as this source used to) meant
 * one `ingested_events` row per alert — 2000 alerts in a minute became
 * 2000 rows, all in front of every other tenant in the drain's global
 * `occurredAt ASC` queue, each one an Activity row, a Memory write, a
 * triage comment and a fire of every `{kind:'incident'}` trigger. The
 * issue is the unit of work (that is what a Sentry issue IS — one
 * fingerprint), so alerts inside one bucket are the same revision and
 * the spine's `(source, sourceEventId)` dedupe collapses them to a
 * single row. Five minutes caps one flapping issue at 12 rows an hour
 * while a genuinely later alert still lands as a new revision.
 */
export const SENTRY_EVENT_ALERT_BUCKET_MS = 5 * 60_000;

/** `issue` resource actions worth a revision of the incident. */
export const SENTRY_ISSUE_ACTIONS: readonly string[] = [
    'created',
    'resolved',
    'unresolved',
    'assigned',
    'ignored',
    'archived',
    'unarchived',
];

/**
 * The start of the `widthMs` bucket `value` falls in, as an ISO string.
 *
 * Used to build a dedupe identity that is a function of WHEN something
 * happened rather than of which individual delivery carried it. A body
 * with no usable vendor timestamp buckets the receive time instead of
 * being stamped with the raw clock: a replayed delivery then collapses
 * into the bucket it is replayed in rather than minting a fresh row per
 * replay, and a genuinely later alert still opens a new bucket.
 */
function bucketOf(value: string | number | null | undefined, widthMs: number): string {
    const ms = epochMsOf(value) ?? Date.now();
    return new Date(Math.floor(ms / widthMs) * widthMs).toISOString();
}

/**
 * Epoch milliseconds for a vendor timestamp, or `undefined`.
 *
 * Mirrors `isoOrNow`'s parsing (Sentry reports unix epochs in SECONDS on
 * some resources and ISO strings on others) without its `now()`
 * fallback — the caller decides what "no timestamp" means.
 */
function epochMsOf(value: string | number | null | undefined): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
    }
    return undefined;
}

/**
 * The vendor's own revision timestamp, or a bounded stand-in.
 *
 * Never `now()`: this value goes into `sourceEventId`, which IS the
 * replay control. When the vendor stamps the revision the identity is
 * exact (a redelivery of the same transition dedupes to zero); when it
 * does not, the identity degrades to a 5-minute bucket, which is
 * bounded, rather than to the clock, which is not.
 */
function revisionStampOf(value: string | number | null | undefined): string {
    const ms = epochMsOf(value);
    if (ms !== undefined) return new Date(ms).toISOString();
    return bucketOf(undefined, SENTRY_EVENT_ALERT_BUCKET_MS);
}

/** The subset of a Sentry integration webhook body the source reads. */
export interface SentryWebhookBody {
    action?: string;
    installation?: { uuid?: string };
    actor?: { type?: string; id?: string | number; name?: string };
    data?: {
        triggered_rule?: string;
        event?: SentryEventData;
        issue?: SentryIssueData;
        installation?: { uuid?: string; status?: string; organization?: { slug?: string } };
    };
}

export interface SentryEventData {
    event_id?: string;
    issue_id?: string | number;
    issue?: { id?: string | number };
    web_url?: string;
    issue_url?: string;
    url?: string;
    title?: string;
    message?: string;
    culprit?: string;
    level?: string;
    release?: string | { version?: string } | null;
    environment?: string;
    /** Numeric project id in event alerts (no slug on this resource). */
    project?: string | number;
    project_id?: string | number;
    platform?: string;
    datetime?: string;
    timestamp?: number | string;
    /** `[["release","1.2.3"], …]` on the wire; tolerate `{ key, value }` objects too. */
    tags?: ReadonlyArray<readonly string[] | { key?: string; value?: string }>;
}

export interface SentryIssueData {
    id?: string | number;
    shortId?: string;
    title?: string;
    culprit?: string;
    level?: string;
    status?: string;
    permalink?: string;
    web_url?: string;
    platform?: string;
    firstSeen?: string;
    lastSeen?: string;
    count?: string | number;
    userCount?: number;
    project?: { id?: string | number; slug?: string; name?: string; platform?: string };
}

/** One inbound Sentry delivery, as the receiver hands it over. */
export interface SentryIncidentInput {
    /** `Sentry-Hook-Resource` header. */
    readonly resource: string | undefined;
    /** `body.action` (or the header-derived action). */
    readonly action: string | undefined;
    readonly body: SentryWebhookBody;
}

/** Read the `release` / `environment` a tag list carries. */
function tagValue(tags: SentryEventData['tags'], key: string): string | undefined {
    if (!Array.isArray(tags)) return undefined;
    for (const tag of tags) {
        if (Array.isArray(tag)) {
            if (tag[0] === key) return nonEmpty(tag[1]);
        } else if (tag && typeof tag === 'object' && tag.key === key) {
            return nonEmpty(tag.value);
        }
    }
    return undefined;
}

/** `https://sentry.io/organizations/<org>/issues/<id>/events/<eid>/` → the issue page. */
function issuePageFromEventUrl(webUrl: string | undefined): string | undefined {
    if (!webUrl) return undefined;
    const match = /^(.*\/issues\/[^/?#]+)\//.exec(webUrl);
    return match ? `${match[1]}/` : webUrl;
}

/**
 * Sentry issue / event alerts as incidents.
 *
 * Receives ONLY signature-verified, owner-attributed deliveries from
 * `SentryWebhookController`; this class is a pure normalizer. The
 * resulting envelope carries the issue link, culprit, title, level,
 * last-seen release, environment and project so the triage Task can
 * render them without a second Sentry round-trip.
 *
 * Identity: the Sentry **issue id** (`data.issue.id` /
 * `data.event.issue_id`) — every alert for the same grouped issue is a
 * revision of ONE incident, which is what lets the triage filer keep a
 * single Task per issue while a repeated alert refreshes it.
 *
 * Work routing: `workHint { kind: 'tracker-team' }` keyed on the
 * project SLUG when the resource carries one (`issue`) and on the
 * numeric project id otherwise (`event_alert` has no slug) — claim both
 * under **Tracker team** on the Work so each resource routes.
 *
 * Never logs or persists the raw body: event alerts carry stack frames
 * and user context.
 */
@Injectable()
export class SentryIncidentSource implements IncidentSource<SentryIncidentInput> {
    readonly provider = 'sentry' as const;
    readonly source = SENTRY_EVENT_SOURCE;

    normalize(input: SentryIncidentInput): IngestedEventEnvelope | null {
        const resource = nonEmpty(input.resource);
        if (!resource || !SENTRY_INCIDENT_RESOURCES.includes(resource)) return null;
        const body = input.body ?? {};
        const action = nonEmpty(input.action) ?? nonEmpty(body.action);
        const installationUuid = nonEmpty(body.installation?.uuid);
        const actor = nonEmpty(body.actor?.name);

        if (resource === 'event_alert') {
            return this.fromEventAlert(body, action, installationUuid, actor);
        }
        return this.fromIssue(body, action, installationUuid, actor);
    }

    private fromEventAlert(
        body: SentryWebhookBody,
        action: string | undefined,
        installationUuid: string | undefined,
        actor: string | undefined,
    ): IngestedEventEnvelope | null {
        const event = body.data?.event;
        if (!event) return null;
        const issueId = this.idOf(event.issue_id ?? event.issue?.id);
        if (!issueId) return null;
        const eventId = nonEmpty(event.event_id);

        const title = nonEmpty(event.title) ?? nonEmpty(event.message) ?? `Sentry issue ${issueId}`;
        const release =
            typeof event.release === 'string'
                ? nonEmpty(event.release)
                : (nonEmpty(event.release?.version) ?? tagValue(event.tags, 'release'));
        const environment = nonEmpty(event.environment) ?? tagValue(event.tags, 'environment');
        const projectId = this.idOf(event.project_id ?? event.project);
        const level = nonEmpty(event.level);
        const eventUrl = httpsUrl(event.web_url);
        const issueUrl = httpsUrl(issuePageFromEventUrl(event.web_url)) ?? eventUrl;
        const culprit = nonEmpty(event.culprit);
        const rule = nonEmpty(body.data?.triggered_rule);

        const payload: IncidentPayload = {
            provider: this.provider,
            externalId: issueId,
            title,
            ...(issueUrl ? { url: issueUrl } : {}),
            ...(culprit ? { culprit } : {}),
            ...(level ? { level: level.toLowerCase() } : {}),
            ...(release ? { release } : {}),
            ...(environment ? { environment } : {}),
            ...(projectId ? { projectId } : {}),
            action: action ?? 'triggered',
            resource: 'event_alert',
            issueId,
            ...(eventId ? { eventId } : {}),
            ...(eventUrl ? { eventUrl } : {}),
            ...(rule ? { triggeredRule: rule } : {}),
            ...(nonEmpty(event.platform) ? { platform: event.platform } : {}),
            ...(installationUuid ? { installationUuid } : {}),
        };

        const occurredAt = event.datetime ?? event.timestamp;
        return buildIncidentEnvelope({
            source: this.source,
            // One envelope per ISSUE per bucket, not per alerting event:
            // see {@link SENTRY_EVENT_ALERT_BUCKET_MS}. The bucket is
            // derived from the vendor timestamp when there is one, so a
            // replayed delivery lands in the bucket it originally
            // occurred in and dedupes instead of minting a new row.
            sourceEventId: `event_alert:${issueId}:${bucketOf(occurredAt, SENTRY_EVENT_ALERT_BUCKET_MS)}`,
            occurredAt,
            ...(actor ? { actor } : {}),
            ...(issueUrl ? { sourceUrl: issueUrl } : {}),
            ...(projectId ? { workHint: { kind: 'tracker-team', externalId: projectId } } : {}),
            payload,
        });
    }

    private fromIssue(
        body: SentryWebhookBody,
        action: string | undefined,
        installationUuid: string | undefined,
        actor: string | undefined,
    ): IngestedEventEnvelope | null {
        const issue = body.data?.issue;
        if (!issue) return null;
        if (!action || !SENTRY_ISSUE_ACTIONS.includes(action)) return null;
        const issueId = this.idOf(issue.id);
        if (!issueId) return null;

        const title = nonEmpty(issue.title) ?? `Sentry issue ${nonEmpty(issue.shortId) ?? issueId}`;
        const url = httpsUrl(issue.permalink) ?? httpsUrl(issue.web_url);
        const projectSlug = nonEmpty(issue.project?.slug);
        const projectId = this.idOf(issue.project?.id);
        const level = nonEmpty(issue.level);
        const culprit = nonEmpty(issue.culprit);
        const status = nonEmpty(issue.status);
        const lastSeen = nonEmpty(issue.lastSeen);

        const payload: IncidentPayload = {
            provider: this.provider,
            externalId: issueId,
            title,
            ...(url ? { url } : {}),
            ...(culprit ? { culprit } : {}),
            ...(level ? { level: level.toLowerCase() } : {}),
            ...(projectSlug ? { project: projectSlug } : {}),
            ...(projectId ? { projectId } : {}),
            ...(status ? { status } : {}),
            action,
            resource: 'issue',
            issueId,
            ...(nonEmpty(issue.shortId) ? { shortId: issue.shortId } : {}),
            ...(nonEmpty(issue.project?.name) ? { projectName: issue.project?.name } : {}),
            ...(nonEmpty(issue.platform) ? { platform: issue.platform } : {}),
            ...(nonEmpty(issue.firstSeen) ? { firstSeen: issue.firstSeen } : {}),
            ...(lastSeen ? { lastSeen } : {}),
            ...(issue.count !== undefined && issue.count !== null
                ? { count: String(issue.count) }
                : {}),
            ...(typeof issue.userCount === 'number' ? { userCount: issue.userCount } : {}),
            ...(installationUuid ? { installationUuid } : {}),
        };

        const hintId = projectSlug ?? projectId;
        return buildIncidentEnvelope({
            source: this.source,
            // Revision = lifecycle action + when the issue was last seen: a
            // retried delivery of the same transition dedupes, a later
            // transition (resolved → unresolved) lands as a new event.
            //
            // `revisionStampOf` — NOT `isoOrNow` — because a body with
            // neither `lastSeen` nor `firstSeen` would otherwise get
            // `now()` stamped into its dedupe identity, and a captured,
            // still-signed delivery replayed N times would mint N
            // distinct rows. The whole documented replay control on this
            // receiver is the spine's `(source, sourceEventId)` dedupe,
            // so that identity must not contain the clock.
            sourceEventId: `issue:${issueId}:${action}:${revisionStampOf(lastSeen ?? issue.firstSeen)}`,
            occurredAt: lastSeen ?? issue.firstSeen,
            ...(actor ? { actor } : {}),
            ...(url ? { sourceUrl: url } : {}),
            ...(hintId ? { workHint: { kind: 'tracker-team', externalId: hintId } } : {}),
            payload,
        });
    }

    /** A string id out of the string-or-number shapes Sentry uses. */
    private idOf(value: string | number | null | undefined): string | undefined {
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return nonEmpty(value);
    }
}
