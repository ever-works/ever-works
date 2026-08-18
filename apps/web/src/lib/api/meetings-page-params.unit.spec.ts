// Meetings page params — the whitelisting + href building shared by the
// `/meetings` redirect route and the Meetings block on the Memory page
// (navigation consolidation, docs/specs/features/navigation-consolidation).

import { describe, expect, it } from 'vitest';
import {
    MEETINGS_PAGE_SIZE,
    buildMeetingsHref,
    parseMeetingsSearchParams,
} from './meetings-page-params';

describe('MEETINGS_PAGE_SIZE', () => {
    it('is a positive page size the look-ahead fetch can add 1 to', () => {
        expect(MEETINGS_PAGE_SIZE).toBeGreaterThan(0);
        expect(Number.isInteger(MEETINGS_PAGE_SIZE)).toBe(true);
    });
});

describe('parseMeetingsSearchParams', () => {
    it('keeps a source from the closed set', () => {
        expect(parseMeetingsSearchParams({ source: 'zoom' })).toEqual({
            source: 'zoom',
            workId: undefined,
            offset: 0,
        });
    });

    it('drops a source outside the closed set', () => {
        expect(parseMeetingsSearchParams({ source: 'teams-meeting' }).source).toBeUndefined();
    });

    it('keeps a uuid workId and drops anything else', () => {
        const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        expect(parseMeetingsSearchParams({ workId: uuid }).workId).toBe(uuid);
        expect(parseMeetingsSearchParams({ workId: '1; DROP TABLE works' }).workId).toBeUndefined();
        expect(parseMeetingsSearchParams({ workId: 'not-a-uuid' }).workId).toBeUndefined();
    });

    it('clamps a negative, NaN or missing offset to 0', () => {
        expect(parseMeetingsSearchParams({ offset: '-5' }).offset).toBe(0);
        expect(parseMeetingsSearchParams({ offset: 'abc' }).offset).toBe(0);
        expect(parseMeetingsSearchParams({}).offset).toBe(0);
        expect(parseMeetingsSearchParams({ offset: '24' }).offset).toBe(24);
    });

    it('takes the first entry when a param repeats', () => {
        expect(
            parseMeetingsSearchParams({ source: ['manual', 'zoom'], offset: ['12', '99'] }),
        ).toEqual({ source: 'manual', workId: undefined, offset: 12 });
    });
});

describe('buildMeetingsHref', () => {
    it('returns the bare base path when nothing is filtered', () => {
        expect(buildMeetingsHref('/meetings', {})).toBe('/meetings');
    });

    it('appends the hash even with no query string', () => {
        expect(buildMeetingsHref('/memory', {}, '#meetings')).toBe('/memory#meetings');
    });

    it('puts the query before the hash', () => {
        expect(buildMeetingsHref('/memory', { source: 'zoom' }, '#meetings')).toBe(
            '/memory?source=zoom#meetings',
        );
    });

    it('omits a zero offset and keeps a positive one', () => {
        const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        expect(buildMeetingsHref('/memory', { workId: uuid, offset: 0 }, '#meetings')).toBe(
            `/memory?workId=${uuid}#meetings`,
        );
        expect(buildMeetingsHref('/memory', { workId: uuid, offset: 12 }, '#meetings')).toBe(
            `/memory?workId=${uuid}&offset=12#meetings`,
        );
    });
});
