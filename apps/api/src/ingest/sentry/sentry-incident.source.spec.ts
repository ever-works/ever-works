import { INCIDENT_EVENT_KIND } from '../incidents/incident-source.types';
import { SentryIncidentSource } from './sentry-incident.source';

const INSTALLATION_UUID = '5f6e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f';

function eventAlertBody(eventOverrides: Record<string, unknown> = {}) {
    return {
        action: 'triggered',
        installation: { uuid: INSTALLATION_UUID },
        actor: { type: 'application', id: 'sentry', name: 'Sentry' },
        data: {
            triggered_rule: 'Notify on new errors',
            event: {
                event_id: 'e1f2a3b4c5d6',
                issue_id: '4501',
                web_url:
                    'https://sentry.io/organizations/ever-co/issues/4501/events/e1f2a3b4c5d6/?project=77',
                issue_url: 'https://sentry.io/api/0/organizations/ever-co/issues/4501/',
                title: 'TypeError: Cannot read properties of undefined',
                culprit: 'apps/api/src/tasks/tasks.service.ts in create',
                level: 'error',
                release: 'ever-works@1.42.0',
                environment: 'production',
                project: 77,
                platform: 'node',
                datetime: '2026-09-01T12:00:00.000Z',
                tags: [
                    ['release', 'ever-works@1.42.0'],
                    ['environment', 'production'],
                ],
                ...eventOverrides,
            },
        },
    };
}

function issueBody(action: string, issueOverrides: Record<string, unknown> = {}) {
    return {
        action,
        installation: { uuid: INSTALLATION_UUID },
        actor: { type: 'user', id: 1, name: 'Ada' },
        data: {
            issue: {
                id: '4501',
                shortId: 'EVER-WORKS-1X',
                title: 'TypeError: Cannot read properties of undefined',
                culprit: 'apps/api/src/tasks/tasks.service.ts in create',
                level: 'error',
                status: 'unresolved',
                permalink: 'https://sentry.io/organizations/ever-co/issues/4501/',
                platform: 'node',
                firstSeen: '2026-08-30T09:00:00.000Z',
                lastSeen: '2026-09-01T12:00:00.000Z',
                count: '17',
                userCount: 3,
                project: {
                    id: 77,
                    slug: 'ever-works-api',
                    name: 'Ever Works API',
                    platform: 'node',
                },
                ...issueOverrides,
            },
        },
    };
}

describe('SentryIncidentSource', () => {
    const source = new SentryIncidentSource();

    it('declares the provider and its own source namespace', () => {
        expect(source.provider).toBe('sentry');
        expect(source.source).toBe('sentry');
    });

    describe('event_alert resource', () => {
        it('normalizes an event alert into an incident carrying link, culprit, level, release, environment and project', () => {
            const envelope = source.normalize({
                resource: 'event_alert',
                action: 'triggered',
                body: eventAlertBody(),
            });
            expect(envelope).toMatchObject({
                source: 'sentry',
                kind: INCIDENT_EVENT_KIND,
                // Keyed on the issue and the 5-minute bucket its
                // `datetime` falls in, NOT on the individual `event_id` —
                // see the coalescing test below.
                sourceEventId: 'event_alert:4501:2026-09-01T12:00:00.000Z',
                occurredAt: '2026-09-01T12:00:00.000Z',
                actor: { name: 'Sentry' },
                subject: {
                    type: 'issue',
                    externalId: '4501',
                    title: 'TypeError: Cannot read properties of undefined',
                },
                sourceUrl: 'https://sentry.io/organizations/ever-co/issues/4501/',
                workHint: { kind: 'tracker-team', externalId: '77' },
                payload: {
                    provider: 'sentry',
                    externalId: '4501',
                    title: 'TypeError: Cannot read properties of undefined',
                    url: 'https://sentry.io/organizations/ever-co/issues/4501/',
                    culprit: 'apps/api/src/tasks/tasks.service.ts in create',
                    level: 'error',
                    release: 'ever-works@1.42.0',
                    environment: 'production',
                    projectId: '77',
                    action: 'triggered',
                    resource: 'event_alert',
                    issueId: '4501',
                    eventId: 'e1f2a3b4c5d6',
                    eventUrl:
                        'https://sentry.io/organizations/ever-co/issues/4501/events/e1f2a3b4c5d6/?project=77',
                    triggeredRule: 'Notify on new errors',
                    installationUuid: INSTALLATION_UUID,
                },
            });
        });

        it('reads release / environment off the tag list when the top-level fields are absent', () => {
            const envelope = source.normalize({
                resource: 'event_alert',
                action: 'triggered',
                body: eventAlertBody({ release: undefined, environment: undefined }),
            });
            expect(envelope?.payload).toMatchObject({
                release: 'ever-works@1.42.0',
                environment: 'production',
            });
        });

        /**
         * This used to assert the opposite — one envelope per alerting
         * EVENT (`event_alert:<issue>:<event_id>`). That is what turned a
         * flapping Sentry issue into thousands of `ingested_events` rows:
         * the drain is a five-minute cron with a fifty-row batch, so two
         * thousand alerts are hours of backlog IN FRONT of every other
         * tenant's genuinely new work, and each row also costs an
         * Activity row, a Memory write, a triage comment and a fire of
         * every `{kind:'incident'}` trigger.
         *
         * A Sentry issue IS one fingerprint. Alerts inside one bucket are
         * the same revision of it, so they collapse; a later alert still
         * opens a new bucket and lands as a new revision.
         */
        it('collapses alerts for one issue inside a bucket, and takes a NEW revision after it', () => {
            const first = source.normalize({
                resource: 'event_alert',
                action: 'triggered',
                body: eventAlertBody(),
            });
            const sameBucket = source.normalize({
                resource: 'event_alert',
                action: 'triggered',
                body: eventAlertBody({
                    event_id: 'ffffffffffff',
                    datetime: '2026-09-01T12:04:59.000Z',
                    release: 'ever-works@1.43.0',
                }),
            });
            const laterBucket = source.normalize({
                resource: 'event_alert',
                action: 'triggered',
                body: eventAlertBody({
                    event_id: 'aaaaaaaaaaaa',
                    datetime: '2026-09-01T12:05:00.000Z',
                }),
            });

            expect(sameBucket?.subject?.externalId).toBe(first?.subject?.externalId);
            // Different `event_id`, same issue, same bucket → the spine's
            // (source, sourceEventId) dedupe writes exactly one row.
            expect(sameBucket?.sourceEventId).toBe(first?.sourceEventId);
            // The facts still travel: the winner of a bucket carries the
            // latest release it saw.
            expect(sameBucket?.payload.release).toBe('ever-works@1.43.0');
            // A genuinely later alert is a new revision, not swallowed.
            expect(laterBucket?.sourceEventId).not.toBe(first?.sourceEventId);
        });

        it('is deterministic for an exact redelivery', () => {
            const input = { resource: 'event_alert', action: 'triggered', body: eventAlertBody() };
            expect(source.normalize(input)?.sourceEventId).toBe(
                source.normalize(input)?.sourceEventId,
            );
        });

        /**
         * The documented replay control on this receiver is the spine's
         * `(source, sourceEventId)` dedupe — Sentry's `Sentry-Hook-Timestamp`
         * is not part of the signed material, so nothing else bounds a
         * replay. That control only holds if the identity is a function
         * of the DELIVERY, never of the clock: `isoOrNow()` stamped a
         * fresh `now` whenever the vendor timestamp was absent, so a
         * captured, still-signed delivery replayed N times minted N rows.
         */
        it('does not put the CLOCK in the dedupe identity when the vendor omits its timestamp', () => {
            const noTimestamp = {
                resource: 'event_alert',
                action: 'triggered',
                body: eventAlertBody({ datetime: undefined, timestamp: undefined }),
            };
            jest.useFakeTimers().setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
            const first = source.normalize(noTimestamp)?.sourceEventId;
            // A replay a full minute later — under a `now()` fallback this
            // is a brand new identity and a brand new row.
            jest.setSystemTime(new Date('2026-09-01T12:01:00.000Z'));
            const replay = source.normalize(noTimestamp)?.sourceEventId;
            jest.useRealTimers();
            expect(replay).toBe(first);
        });
    });

    describe('issue resource replay', () => {
        it('keeps an unstamped issue delivery on ONE dedupe identity across replays', () => {
            const unstamped = {
                resource: 'issue',
                action: 'unresolved',
                body: issueBody('unresolved', { lastSeen: undefined, firstSeen: undefined }),
            };
            jest.useFakeTimers().setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
            const first = source.normalize(unstamped)?.sourceEventId;
            jest.setSystemTime(new Date('2026-09-01T12:01:00.000Z'));
            const replay = source.normalize(unstamped)?.sourceEventId;
            jest.useRealTimers();
            expect(replay).toBe(first);
        });

        it('still keys a stamped transition on the vendor timestamp, exactly', () => {
            const envelope = source.normalize({
                resource: 'issue',
                action: 'unresolved',
                body: issueBody('unresolved'),
            });
            expect(envelope?.sourceEventId).toBe('issue:4501:unresolved:2026-09-01T12:00:00.000Z');
        });

        it('refuses an alert without an issue id', () => {
            expect(
                source.normalize({
                    resource: 'event_alert',
                    action: 'triggered',
                    body: eventAlertBody({ issue_id: undefined }),
                }),
            ).toBeNull();
        });
    });

    describe('issue resource', () => {
        it('normalizes issue.created with the project slug as the Work hint', () => {
            const envelope = source.normalize({
                resource: 'issue',
                action: 'created',
                body: issueBody('created'),
            });
            expect(envelope).toMatchObject({
                source: 'sentry',
                kind: INCIDENT_EVENT_KIND,
                sourceEventId: 'issue:4501:created:2026-09-01T12:00:00.000Z',
                occurredAt: '2026-09-01T12:00:00.000Z',
                actor: { name: 'Ada' },
                subject: { type: 'issue', externalId: '4501' },
                sourceUrl: 'https://sentry.io/organizations/ever-co/issues/4501/',
                workHint: { kind: 'tracker-team', externalId: 'ever-works-api' },
                payload: {
                    provider: 'sentry',
                    externalId: '4501',
                    level: 'error',
                    status: 'unresolved',
                    project: 'ever-works-api',
                    projectId: '77',
                    projectName: 'Ever Works API',
                    action: 'created',
                    resource: 'issue',
                    shortId: 'EVER-WORKS-1X',
                    count: '17',
                    userCount: 3,
                    lastSeen: '2026-09-01T12:00:00.000Z',
                },
            });
        });

        it('lands each lifecycle transition as a new revision of the same incident', () => {
            const created = source.normalize({
                resource: 'issue',
                action: 'created',
                body: issueBody('created'),
            });
            const resolved = source.normalize({
                resource: 'issue',
                action: 'resolved',
                body: issueBody('resolved', { status: 'resolved' }),
            });
            expect(resolved?.subject?.externalId).toBe(created?.subject?.externalId);
            expect(resolved?.sourceEventId).not.toBe(created?.sourceEventId);
            expect(resolved?.payload.status).toBe('resolved');
        });

        it('falls back to the body action when the receiver passes none', () => {
            const envelope = source.normalize({
                resource: 'issue',
                action: undefined,
                body: issueBody('ignored'),
            });
            expect(envelope?.payload.action).toBe('ignored');
        });

        it('ignores issue actions that are not a lifecycle change', () => {
            expect(
                source.normalize({
                    resource: 'issue',
                    action: 'starred',
                    body: issueBody('starred'),
                }),
            ).toBeNull();
        });

        it('refuses an issue without an id', () => {
            expect(
                source.normalize({
                    resource: 'issue',
                    action: 'created',
                    body: issueBody('created', { id: undefined }),
                }),
            ).toBeNull();
        });
    });

    describe('resources that are not incidents', () => {
        it.each(['installation', 'comment', 'metric_alert', 'error', undefined, ''])(
            'returns null for %p',
            (resource) => {
                expect(
                    source.normalize({ resource, action: 'created', body: issueBody('created') }),
                ).toBeNull();
            },
        );
    });

    it('drops a non-https issue link instead of persisting it', () => {
        const envelope = source.normalize({
            resource: 'issue',
            action: 'created',
            body: issueBody('created', { permalink: 'http://evil.example/issues/1' }),
        });
        expect(envelope?.sourceUrl).toBeUndefined();
        expect(envelope?.payload.url).toBeUndefined();
    });

    it('caps a runaway title at the ingested_events column width', () => {
        const envelope = source.normalize({
            resource: 'issue',
            action: 'created',
            body: issueBody('created', { title: 'x'.repeat(900) }),
        });
        expect(envelope?.subject?.title).toHaveLength(500);
        expect((envelope?.payload.title as string).length).toBe(500);
    });
});
