import {
    matchesEvent,
    matchesPattern,
    normalizeEventMatcher,
    type MatchableEvent,
} from '../trigger-event-matcher';
import type { InboundTriggerEventMatcher } from '../../entities/inbound-trigger.entity';

const EVENT: MatchableEvent = {
    source: 'github',
    kind: 'github.push',
    workId: 'a3e6a2a8-6a1e-4b7d-9c0a-2f2b3c4d5e6f',
};

describe('matchesPattern', () => {
    it.each<[pattern: string, value: string, expected: boolean]>([
        ['*', 'anything', true],
        ['*', '', true],
        ['github', 'github', true],
        ['github', 'gitlab', false],
        ['github.*', 'github.push', true],
        ['github.*', 'github.', true],
        ['github.*', 'github', false],
        ['github.*', 'slack.message', false],
        // Exact match only — no infix/leading wildcard support.
        ['*.push', 'github.push', false],
        ['GitHub', 'github', false],
    ])('pattern %s vs %s → %s', (pattern, value, expected) => {
        expect(matchesPattern(pattern, value)).toBe(expected);
    });

    it('a non-lone-* pattern never matches a missing value', () => {
        expect(matchesPattern('github', null)).toBe(false);
        expect(matchesPattern('github.*', undefined)).toBe(false);
        expect(matchesPattern('*', null)).toBe(true);
    });
});

describe('normalizeEventMatcher', () => {
    it('keeps only recognized non-empty string keys', () => {
        expect(
            normalizeEventMatcher({
                source: ' github ',
                kind: '',
                bogus: 'x',
            } as InboundTriggerEventMatcher),
        ).toEqual({ source: 'github' });
    });

    it('returns null for null/undefined/empty/garbage input', () => {
        expect(normalizeEventMatcher(null)).toBeNull();
        expect(normalizeEventMatcher(undefined)).toBeNull();
        expect(normalizeEventMatcher({})).toBeNull();
        expect(normalizeEventMatcher({ source: '   ' })).toBeNull();
        expect(
            normalizeEventMatcher({ source: 42 } as unknown as InboundTriggerEventMatcher),
        ).toBeNull();
    });
});

describe('matchesEvent', () => {
    it.each<[label: string, matcher: InboundTriggerEventMatcher, expected: boolean]>([
        ['exact source', { source: 'github' }, true],
        ['wrong source', { source: 'slack' }, false],
        ['source wildcard', { source: 'git*' }, true],
        ['exact kind', { kind: 'github.push' }, true],
        ['kind prefix wildcard', { kind: 'github.*' }, true],
        ['kind lone wildcard', { kind: '*' }, true],
        ['wrong kind', { kind: 'github.merge' }, false],
        ['exact workId', { workId: 'a3e6a2a8-6a1e-4b7d-9c0a-2f2b3c4d5e6f' }, true],
        ['wrong workId', { workId: '00000000-0000-0000-0000-000000000000' }, false],
        ['AND semantics — all keys must hold', { source: 'github', kind: 'slack.*' }, false],
        ['AND semantics — all keys hold', { source: 'github', kind: 'github.*' }, true],
    ])('%s → %s', (_label, matcher, expected) => {
        expect(matchesEvent(matcher, EVENT)).toBe(expected);
    });

    it('an empty (or null) matcher matches NOTHING — never a firehose subscription', () => {
        expect(matchesEvent({}, EVENT)).toBe(false);
        expect(matchesEvent(null, EVENT)).toBe(false);
        expect(matchesEvent(undefined, EVENT)).toBe(false);
    });

    it('a workId matcher never matches an event with no workId', () => {
        expect(
            matchesEvent(
                { workId: 'a3e6a2a8-6a1e-4b7d-9c0a-2f2b3c4d5e6f' },
                { source: 'github', kind: 'github.push', workId: null },
            ),
        ).toBe(false);
    });

    it('unrecognized matcher keys are ignored, not treated as constraints', () => {
        const matcher = { kind: 'github.*', evil: 'value' } as InboundTriggerEventMatcher;
        expect(matchesEvent(matcher, EVENT)).toBe(true);
    });
});
