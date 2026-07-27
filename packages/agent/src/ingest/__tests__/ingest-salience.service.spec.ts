import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { IngestSalienceService, SALIENCE_BASE_SCORE } from '../ingest-salience.service';

/**
 * Ingest salience filter (audit item (k)).
 *
 * The load-bearing assertion is the FIRST one: with no env configured
 * the filter admits everything. Every deployment that never opts in must
 * keep ingesting byte-for-byte what it ingested before, because silently
 * dropping a customer's events is a much worse failure than a noisy feed.
 */

const envelope = (overrides: Partial<IngestedEventEnvelope> = {}): IngestedEventEnvelope => ({
    id: 'env-1',
    source: 'slack-connector',
    sourceEventId: 'evt-1',
    kind: 'slack.message',
    occurredAt: '2026-07-01T10:00:00.000Z',
    actor: { name: 'Ada' },
    subject: { type: 'channel', externalId: 'C123', title: 'general' },
    sourceUrl: 'https://example.com/archives/C123/p1',
    payload: { text: 'hello' },
    ...overrides,
});

/** Minimum-information envelope: no title, no url, empty payload, no actor. */
const bareEnvelope = (overrides: Partial<IngestedEventEnvelope> = {}): IngestedEventEnvelope => {
    const stripped = envelope();
    delete (stripped as Partial<IngestedEventEnvelope>).actor;
    delete (stripped as Partial<IngestedEventEnvelope>).subject;
    delete (stripped as Partial<IngestedEventEnvelope>).sourceUrl;
    return { ...stripped, payload: {}, ...overrides };
};

describe('IngestSalienceService', () => {
    const ENV_KEYS = [
        'INGEST_SALIENCE_MIN_SCORE',
        'INGEST_SALIENCE_MUTED_KINDS',
        'INGEST_SALIENCE_MUTED_ACTORS',
    ] as const;

    let service: IngestSalienceService;

    beforeEach(() => {
        for (const key of ENV_KEYS) delete process.env[key];
        service = new IngestSalienceService();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) delete process.env[key];
    });

    describe('safe default (unconfigured)', () => {
        it('⭐ admits EVERY envelope when nothing is configured — current behaviour preserved', () => {
            expect(service.isEnabled()).toBe(false);
            const candidates = [
                envelope(),
                bareEnvelope(),
                envelope({ kind: 'slack.typing' }),
                envelope({ actor: { name: 'ci-bot' }, kind: 'github.heartbeat' }),
                bareEnvelope({ kind: 'x.ping', actor: { name: 'noreply-bot' } }),
            ];
            for (const candidate of candidates) {
                expect(service.isSalient(candidate)).toBe(true);
            }
        });

        it('a garbage min-score is treated as OFF, never as "drop everything"', () => {
            process.env.INGEST_SALIENCE_MIN_SCORE = 'not-a-number';
            expect(service.isEnabled()).toBe(false);
            expect(service.isSalient(bareEnvelope({ kind: 'x.ping' }))).toBe(true);
        });

        it('a negative min-score is treated as OFF', () => {
            process.env.INGEST_SALIENCE_MIN_SCORE = '-10';
            expect(service.isEnabled()).toBe(false);
            expect(service.isSalient(bareEnvelope({ kind: 'x.ping' }))).toBe(true);
        });
    });

    describe('scoring rubric', () => {
        it('is deterministic and stays inside 0–100', () => {
            const rich = envelope({ kind: 'github.issue.opened' });
            expect(service.score(rich)).toBe(service.score(rich));
            for (const candidate of [rich, bareEnvelope({ kind: 'x.ping' })]) {
                const score = service.score(candidate);
                expect(score).toBeGreaterThanOrEqual(0);
                expect(score).toBeLessThanOrEqual(100);
            }
        });

        it('scores a titled, linked, human-authored issue above the neutral base', () => {
            expect(service.score(envelope({ kind: 'github.issue.opened' }))).toBeGreaterThan(
                SALIENCE_BASE_SCORE,
            );
        });

        it('scores heartbeat/presence chatter below the neutral base', () => {
            expect(service.score(bareEnvelope({ kind: 'slack.presence_change' }))).toBeLessThan(
                SALIENCE_BASE_SCORE,
            );
        });

        it('penalizes bot actors relative to the same event from a human', () => {
            const human = envelope({ kind: 'github.push', actor: { name: 'Ada' } });
            const bot = envelope({ kind: 'github.push', actor: { name: 'dependabot[bot]' } });
            expect(service.score(bot)).toBeLessThan(service.score(human));
        });

        it('penalizes an envelope with nothing to read and nowhere to go', () => {
            const bare = bareEnvelope({ kind: 'demo.thing' });
            const withTitle = envelope({ kind: 'demo.thing' });
            expect(service.score(bare)).toBeLessThan(service.score(withTitle));
        });
    });

    describe('min-score gate', () => {
        it('drops below-threshold envelopes and keeps the rest', () => {
            process.env.INGEST_SALIENCE_MIN_SCORE = '60';
            expect(service.isEnabled()).toBe(true);

            const noisy = bareEnvelope({ kind: 'slack.typing' });
            const signal = envelope({ kind: 'github.issue.opened' });

            expect(service.evaluate(noisy)).toMatchObject({
                salient: false,
                reason: 'below-min-score',
            });
            expect(service.evaluate(signal).salient).toBe(true);
        });

        it('clamps an absurd threshold to 100 rather than rejecting the config', () => {
            process.env.INGEST_SALIENCE_MIN_SCORE = '9999';
            // Everything scores <= 100, so a 100 threshold only admits the
            // theoretical maximum — but the service still answers, it does
            // not throw.
            expect(service.evaluate(envelope()).salient).toBe(false);
        });
    });

    describe('mute lists', () => {
        it('mutes an exact kind regardless of how well it scores', () => {
            process.env.INGEST_SALIENCE_MUTED_KINDS = 'github.issue.opened';
            const signal = envelope({ kind: 'github.issue.opened' });
            expect(service.score(signal)).toBeGreaterThan(SALIENCE_BASE_SCORE);
            expect(service.evaluate(signal)).toMatchObject({
                salient: false,
                reason: 'muted-kind',
            });
        });

        it('supports a trailing wildcard to mute a whole source', () => {
            process.env.INGEST_SALIENCE_MUTED_KINDS = 'slack.*';
            expect(service.isSalient(envelope({ kind: 'slack.message' }))).toBe(false);
            expect(service.isSalient(envelope({ kind: 'github.issue' }))).toBe(true);
        });

        it('matches muted kinds case-insensitively and ignores blank list entries', () => {
            process.env.INGEST_SALIENCE_MUTED_KINDS = ' , SLACK.MESSAGE , ';
            expect(service.isSalient(envelope({ kind: 'slack.message' }))).toBe(false);
        });

        it('mutes an actor by substring so `dependabot` covers `dependabot[bot]`', () => {
            process.env.INGEST_SALIENCE_MUTED_ACTORS = 'dependabot';
            expect(
                service.evaluate(envelope({ actor: { name: 'dependabot[bot]' } })),
            ).toMatchObject({ salient: false, reason: 'muted-actor' });
            expect(service.isSalient(envelope({ actor: { name: 'Ada' } }))).toBe(true);
        });

        it('an actorless envelope is never dropped by the actor mute list', () => {
            process.env.INGEST_SALIENCE_MUTED_ACTORS = 'bot';
            const anonymous = envelope();
            delete (anonymous as Partial<IngestedEventEnvelope>).actor;
            expect(service.isSalient(anonymous)).toBe(true);
        });

        it('mutes win over the score gate — the verdict names the mute, not the score', () => {
            process.env.INGEST_SALIENCE_MIN_SCORE = '1';
            process.env.INGEST_SALIENCE_MUTED_KINDS = 'slack.message';
            expect(service.evaluate(envelope()).reason).toBe('muted-kind');
        });
    });
});
