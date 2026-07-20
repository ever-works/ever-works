import {
    SCORECARD_MAX_METRICS,
    scorecardStatus,
    summarizeScorecard,
    validateScorecard,
} from '../scorecard';
import type { AgentScorecardMetric } from '../../entities/agent.entity';

/**
 * Agent Scorecards increment 1 — pure-helper coverage: status
 * classification, roll-up counts, and the write-validation rules the
 * service enforces (<=12 metrics, kebab-unique keys, finite numbers,
 * label length, known period).
 */
function makeMetric(overrides: Partial<AgentScorecardMetric> = {}): AgentScorecardMetric {
    return {
        key: 'prs-merged',
        label: 'PRs merged',
        target: 10,
        current: 5,
        floor: null,
        stretch: null,
        unit: null,
        period: 'weekly',
        ...overrides,
    };
}

describe('scorecardStatus', () => {
    it('is on_track when current meets the target', () => {
        expect(scorecardStatus(makeMetric({ current: 10, target: 10 }))).toBe('on_track');
        expect(scorecardStatus(makeMetric({ current: 11, target: 10 }))).toBe('on_track');
    });

    it('is behind when current is below target and no floor is breached', () => {
        expect(scorecardStatus(makeMetric({ current: 5, target: 10 }))).toBe('behind');
        expect(scorecardStatus(makeMetric({ current: 5, target: 10, floor: 3 }))).toBe('behind');
    });

    it('is exceeded only when a stretch is set and current reaches it', () => {
        expect(scorecardStatus(makeMetric({ current: 15, target: 10, stretch: 15 }))).toBe(
            'exceeded',
        );
        expect(scorecardStatus(makeMetric({ current: 14, target: 10, stretch: 15 }))).toBe(
            'on_track',
        );
        // No stretch — anything above target is still just on_track.
        expect(scorecardStatus(makeMetric({ current: 100, target: 10 }))).toBe('on_track');
    });

    it('is critical when a floor is set and current falls below it', () => {
        expect(scorecardStatus(makeMetric({ current: 2, target: 10, floor: 3 }))).toBe('critical');
        // At the floor is NOT critical — floor is the minimum acceptable value.
        expect(scorecardStatus(makeMetric({ current: 3, target: 10, floor: 3 }))).toBe('behind');
    });

    it('critical takes precedence over target comparison', () => {
        // Degenerate config (floor above target) still reads as critical.
        expect(scorecardStatus(makeMetric({ current: 11, target: 10, floor: 12 }))).toBe(
            'critical',
        );
    });
});

describe('summarizeScorecard', () => {
    it('returns all-zero counts for an empty scorecard', () => {
        expect(summarizeScorecard([])).toEqual({
            total: 0,
            exceeded: 0,
            onTrack: 0,
            behind: 0,
            critical: 0,
        });
    });

    it('counts each status bucket', () => {
        const metrics = [
            makeMetric({ key: 'a', current: 20, target: 10, stretch: 15 }), // exceeded
            makeMetric({ key: 'b', current: 10, target: 10 }), // on_track
            makeMetric({ key: 'c', current: 5, target: 10 }), // behind
            makeMetric({ key: 'd', current: 1, target: 10, floor: 3 }), // critical
            makeMetric({ key: 'e', current: 4, target: 10, floor: 3 }), // behind
        ];
        expect(summarizeScorecard(metrics)).toEqual({
            total: 5,
            exceeded: 1,
            onTrack: 1,
            behind: 2,
            critical: 1,
        });
    });
});

describe('validateScorecard', () => {
    it('accepts an empty array and a full valid scorecard', () => {
        expect(validateScorecard([])).toBeNull();
        expect(
            validateScorecard([
                makeMetric({ key: 'prs-merged' }),
                makeMetric({
                    key: 'weekly-revenue-usd',
                    label: 'Weekly revenue',
                    target: 1000,
                    current: 250,
                    floor: 100,
                    stretch: 2000,
                    unit: '$',
                    period: 'monthly',
                }),
            ]),
        ).toBeNull();
    });

    it('rejects more than the metric cap', () => {
        const tooMany = Array.from({ length: SCORECARD_MAX_METRICS + 1 }, (_, i) =>
            makeMetric({ key: `metric-${i}` }),
        );
        expect(validateScorecard(tooMany)).toMatch(/at most 12/);
        expect(validateScorecard(tooMany.slice(0, SCORECARD_MAX_METRICS))).toBeNull();
    });

    it('rejects non-kebab keys', () => {
        expect(validateScorecard([makeMetric({ key: 'PRs Merged' })])).toMatch(/kebab-case/);
        expect(validateScorecard([makeMetric({ key: '-leading-dash' })])).toMatch(/kebab-case/);
        expect(validateScorecard([makeMetric({ key: '' })])).toMatch(/kebab-case/);
    });

    it('rejects duplicate keys', () => {
        expect(validateScorecard([makeMetric({ key: 'nps' }), makeMetric({ key: 'nps' })])).toMatch(
            /duplicated/,
        );
    });

    it('rejects empty or over-long labels', () => {
        expect(validateScorecard([makeMetric({ label: '' })])).toMatch(/label/);
        expect(validateScorecard([makeMetric({ label: '   ' })])).toMatch(/label/);
        expect(validateScorecard([makeMetric({ label: 'x'.repeat(81) })])).toMatch(/label/);
        expect(validateScorecard([makeMetric({ label: 'x'.repeat(80) })])).toBeNull();
    });

    it('rejects non-finite numbers', () => {
        expect(validateScorecard([makeMetric({ target: Number.NaN })])).toMatch(/finite/);
        expect(validateScorecard([makeMetric({ current: Number.POSITIVE_INFINITY })])).toMatch(
            /finite/,
        );
        expect(validateScorecard([makeMetric({ floor: Number.NaN })])).toMatch(/floor/);
        expect(validateScorecard([makeMetric({ stretch: Number.NEGATIVE_INFINITY })])).toMatch(
            /stretch/,
        );
        expect(validateScorecard([makeMetric({ target: '10' as unknown as number })])).toMatch(
            /finite/,
        );
    });

    it('rejects unknown periods; floor/stretch may be null or omitted', () => {
        expect(
            validateScorecard([makeMetric({ period: 'daily' as AgentScorecardMetric['period'] })]),
        ).toMatch(/period/);
        const minimal: AgentScorecardMetric = {
            key: 'nps',
            label: 'NPS',
            target: 50,
            current: 40,
            period: 'quarterly',
        };
        expect(validateScorecard([minimal])).toBeNull();
    });
});
