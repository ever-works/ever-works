import {
    classifyIdeaFailure,
    computeBackoffSeconds,
    isTransient,
} from '../idea-failure-classifier';
import { IdeaFailureKind } from '../../entities/work-proposal.entity';

describe('classifyIdeaFailure', () => {
    describe('structured HTTP status', () => {
        it('classifies HTTP 429 as TRANSIENT_RATE_LIMIT', () => {
            expect(classifyIdeaFailure({ status: 429 })).toBe(IdeaFailureKind.TRANSIENT_RATE_LIMIT);
            expect(classifyIdeaFailure({ statusCode: 429 })).toBe(
                IdeaFailureKind.TRANSIENT_RATE_LIMIT,
            );
            expect(classifyIdeaFailure({ response: { status: 429 } })).toBe(
                IdeaFailureKind.TRANSIENT_RATE_LIMIT,
            );
        });

        it('classifies HTTP 5xx as TRANSIENT_UPSTREAM_5XX', () => {
            expect(classifyIdeaFailure({ status: 500 })).toBe(
                IdeaFailureKind.TRANSIENT_UPSTREAM_5XX,
            );
            expect(classifyIdeaFailure({ status: 502 })).toBe(
                IdeaFailureKind.TRANSIENT_UPSTREAM_5XX,
            );
            expect(classifyIdeaFailure({ status: 599 })).toBe(
                IdeaFailureKind.TRANSIENT_UPSTREAM_5XX,
            );
        });

        it('classifies HTTP 4xx (non-429) as PERMANENT_INVALID_INPUT', () => {
            expect(classifyIdeaFailure({ status: 400 })).toBe(
                IdeaFailureKind.PERMANENT_INVALID_INPUT,
            );
            expect(classifyIdeaFailure({ status: 404 })).toBe(
                IdeaFailureKind.PERMANENT_INVALID_INPUT,
            );
            expect(classifyIdeaFailure({ status: 422 })).toBe(
                IdeaFailureKind.PERMANENT_INVALID_INPUT,
            );
        });
    });

    describe('message-pattern fallback', () => {
        it('classifies network-layer errors as TRANSIENT_NETWORK', () => {
            for (const msg of [
                'ECONNREFUSED 127.0.0.1:443',
                'ECONNRESET on socket',
                'ETIMEDOUT after 30000ms',
                'getaddrinfo ENOTFOUND api.example.com',
                'network error',
                'fetch failed',
                'socket hang up',
            ]) {
                expect(classifyIdeaFailure(new Error(msg))).toBe(IdeaFailureKind.TRANSIENT_NETWORK);
            }
        });

        it('classifies rate-limit prose without a status code as TRANSIENT_RATE_LIMIT', () => {
            expect(classifyIdeaFailure('rate limit exceeded')).toBe(
                IdeaFailureKind.TRANSIENT_RATE_LIMIT,
            );
            expect(classifyIdeaFailure('Too Many Requests')).toBe(
                IdeaFailureKind.TRANSIENT_RATE_LIMIT,
            );
            expect(classifyIdeaFailure('OpenAI quota exceeded for org')).toBe(
                IdeaFailureKind.TRANSIENT_RATE_LIMIT,
            );
        });

        it('classifies upstream 5xx prose as TRANSIENT_UPSTREAM_5XX', () => {
            expect(classifyIdeaFailure('Service Unavailable')).toBe(
                IdeaFailureKind.TRANSIENT_UPSTREAM_5XX,
            );
            expect(classifyIdeaFailure('upstream error (502)')).toBe(
                IdeaFailureKind.TRANSIENT_UPSTREAM_5XX,
            );
            expect(classifyIdeaFailure('Bad Gateway')).toBe(IdeaFailureKind.TRANSIENT_UPSTREAM_5XX);
        });

        it('classifies plugin-internal timeouts and aborts as TRANSIENT_PLUGIN', () => {
            expect(classifyIdeaFailure('LangChain timeout after 60s')).toBe(
                IdeaFailureKind.TRANSIENT_PLUGIN,
            );
            expect(classifyIdeaFailure('request aborted')).toBe(IdeaFailureKind.TRANSIENT_PLUGIN);
            expect(classifyIdeaFailure('stream interrupted before completion')).toBe(
                IdeaFailureKind.TRANSIENT_PLUGIN,
            );
            expect(classifyIdeaFailure('provider overloaded')).toBe(
                IdeaFailureKind.TRANSIENT_PLUGIN,
            );
        });

        it('classifies invalid-input prose as PERMANENT_INVALID_INPUT', () => {
            expect(classifyIdeaFailure('invalid input format')).toBe(
                IdeaFailureKind.PERMANENT_INVALID_INPUT,
            );
            expect(classifyIdeaFailure('validation failed: title required')).toBe(
                IdeaFailureKind.PERMANENT_INVALID_INPUT,
            );
            expect(classifyIdeaFailure('schema mismatch on field foo')).toBe(
                IdeaFailureKind.PERMANENT_INVALID_INPUT,
            );
        });

        it('falls back to PERMANENT_UNKNOWN for unrecognized messages', () => {
            expect(classifyIdeaFailure('something went wrong')).toBe(
                IdeaFailureKind.PERMANENT_UNKNOWN,
            );
            expect(classifyIdeaFailure(new Error('asdf qwer'))).toBe(
                IdeaFailureKind.PERMANENT_UNKNOWN,
            );
            expect(classifyIdeaFailure(null)).toBe(IdeaFailureKind.PERMANENT_UNKNOWN);
            expect(classifyIdeaFailure(undefined)).toBe(IdeaFailureKind.PERMANENT_UNKNOWN);
        });
    });

    describe('isTransient', () => {
        it('reports the 4 TRANSIENT_* kinds as transient', () => {
            expect(isTransient(IdeaFailureKind.TRANSIENT_NETWORK)).toBe(true);
            expect(isTransient(IdeaFailureKind.TRANSIENT_RATE_LIMIT)).toBe(true);
            expect(isTransient(IdeaFailureKind.TRANSIENT_UPSTREAM_5XX)).toBe(true);
            expect(isTransient(IdeaFailureKind.TRANSIENT_PLUGIN)).toBe(true);
        });
        it('reports the PERMANENT_* kinds as non-transient', () => {
            expect(isTransient(IdeaFailureKind.PERMANENT_INVALID_INPUT)).toBe(false);
            expect(isTransient(IdeaFailureKind.PERMANENT_UNKNOWN)).toBe(false);
        });
    });
});

describe('computeBackoffSeconds', () => {
    it('produces the spec §3.9 example sequence at default policy', () => {
        // Spec: defaults 60 + 2.0 → 60s, 120s, 240s for 1st/2nd/3rd retries.
        // wait = backoffSeconds * (factor ** attemptsSoFar)
        expect(computeBackoffSeconds(60, 2.0, 0)).toBe(60); // 60 * 2^0 = 60
        expect(computeBackoffSeconds(60, 2.0, 1)).toBe(120);
        expect(computeBackoffSeconds(60, 2.0, 2)).toBe(240);
        expect(computeBackoffSeconds(60, 2.0, 3)).toBe(480);
    });

    it('handles factor=1 (linear / no backoff growth)', () => {
        expect(computeBackoffSeconds(30, 1.0, 0)).toBe(30);
        expect(computeBackoffSeconds(30, 1.0, 5)).toBe(30);
    });

    it('clamps to 1 day max even with a runaway factor', () => {
        // 60 * 4^10 = 60 * 1,048,576 = 62,914,560 — way over a day.
        expect(computeBackoffSeconds(60, 4.0, 10)).toBe(24 * 3600);
    });

    it('clamps negative attempts to 0', () => {
        expect(computeBackoffSeconds(60, 2.0, -5)).toBe(60);
    });

    it('clamps factor < 1 to 1 (no growth — protects against misconfig)', () => {
        expect(computeBackoffSeconds(60, 0.5, 3)).toBe(60);
    });
});
