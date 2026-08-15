import { describe, expect, it } from 'vitest';
import {
    buildCostsQuery,
    costsSeriesColor,
    COSTS_OTHER_SERIES_KEY,
    COSTS_SECTIONS,
    COSTS_SENTINEL_SERIES_COLOR,
    COSTS_UNATTRIBUTED_SERIES_KEY,
    COSTS_WINDOW_DAYS,
    formatCostsDayTick,
    formatSharePercent,
    isCostsWindowDays,
    parseCostsWindowDays,
    shareBarWidth,
} from './costs.shared';

describe('costs window vocabulary', () => {
    it('matches the API allow-list exactly — anything else 400s', () => {
        expect(COSTS_WINDOW_DAYS).toEqual([7, 30, 90]);
    });

    it('pins the proxy route section allow-list to the API paths', () => {
        expect(COSTS_SECTIONS).toEqual(['summary', 'daily', 'by-agent', 'by-model', 'top-runs']);
    });

    it('isCostsWindowDays accepts only the numeric members', () => {
        expect(isCostsWindowDays(7)).toBe(true);
        expect(isCostsWindowDays(90)).toBe(true);
        expect(isCostsWindowDays(31)).toBe(false);
        // A numeric STRING is not a window — the caller must parse first.
        expect(isCostsWindowDays('7')).toBe(false);
        expect(isCostsWindowDays(null)).toBe(false);
    });
});

describe('parseCostsWindowDays', () => {
    it('accepts the vocabulary as numbers and as query strings', () => {
        expect(parseCostsWindowDays(30)).toBe(30);
        expect(parseCostsWindowDays('90')).toBe(90);
        expect(parseCostsWindowDays(' 7 ')).toBe(7);
    });

    it('takes the first value of a repeated query parameter', () => {
        expect(parseCostsWindowDays(['7', '30'])).toBe(7);
    });

    it('returns undefined for anything else so callers can default', () => {
        for (const bad of ['', '  ', 'all', '31', '-7', 'NaN', null, undefined, {}, []]) {
            expect(parseCostsWindowDays(bad)).toBeUndefined();
        }
    });

    it('does not let the empty string coerce to 0 and then to a window', () => {
        // `Number('')` is 0, which is falsy but still a number — the guard
        // has to reject it explicitly.
        expect(parseCostsWindowDays('')).toBeUndefined();
    });
});

describe('buildCostsQuery', () => {
    it('omits everything that was not supplied', () => {
        expect(buildCostsQuery()).toBe('');
        expect(buildCostsQuery({})).toBe('');
    });

    it('serializes the window and the limit', () => {
        expect(buildCostsQuery({ windowDays: 90 })).toBe('?windowDays=90');
        expect(buildCostsQuery({ windowDays: 7, limit: 5 })).toBe('?windowDays=7&limit=5');
    });
});

describe('shareBarWidth', () => {
    it('maps a share to a percentage width', () => {
        expect(shareBarWidth(42.5)).toBe('42.5%');
        expect(shareBarWidth(100)).toBe('100%');
    });

    it('clamps above 100 so a rounding artifact cannot overflow the track', () => {
        expect(shareBarWidth(100.4)).toBe('100%');
    });

    it('collapses non-positive and non-finite shares to zero width', () => {
        expect(shareBarWidth(0)).toBe('0%');
        expect(shareBarWidth(-5)).toBe('0%');
        expect(shareBarWidth(Number.NaN)).toBe('0%');
    });
});

describe('formatSharePercent', () => {
    it('drops the decimal on whole numbers and keeps one otherwise', () => {
        expect(formatSharePercent(25)).toBe('25%');
        expect(formatSharePercent(33.3)).toBe('33.3%');
        expect(formatSharePercent(33.34)).toBe('33.3%');
    });

    it('never renders NaN%', () => {
        expect(formatSharePercent(Number.NaN)).toBe('0%');
    });
});

describe('formatCostsDayTick', () => {
    it('trims the year off an ISO day', () => {
        expect(formatCostsDayTick('2026-08-14')).toBe('08-14');
    });

    it('passes anything unexpected through untouched', () => {
        expect(formatCostsDayTick('week 32')).toBe('week 32');
    });
});

describe('costsSeriesColor', () => {
    it('gives the sentinel series a neutral grey, never a hue', () => {
        expect(costsSeriesColor(COSTS_OTHER_SERIES_KEY, 0)).toBe(COSTS_SENTINEL_SERIES_COLOR);
        expect(costsSeriesColor(COSTS_UNATTRIBUTED_SERIES_KEY, 3)).toBe(
            COSTS_SENTINEL_SERIES_COLOR,
        );
    });

    it('is stable per index so the top spender keeps its colour', () => {
        expect(costsSeriesColor('agent-a', 0)).toBe(costsSeriesColor('agent-b', 0));
        expect(costsSeriesColor('agent-a', 0)).not.toBe(costsSeriesColor('agent-a', 1));
    });

    it('wraps around rather than returning undefined past the palette', () => {
        expect(costsSeriesColor('agent-a', 99)).toMatch(/^#[0-9a-f]{6}$/i);
    });
});
