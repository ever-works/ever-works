import { evaluateUpstreamRateLimits } from '../upstream-rate-limits';

/**
 * APW-09 T8 — FR-26 / FR-27 / FR-39, pure. Every limit has a case that fails without it, the
 * 24-hour window is pinned at both sides of its edge, `maxOpen` is honoured and clamped, and
 * the platform ceiling refuses while the member's own allowance remains.
 */
describe('evaluateUpstreamRateLimits (APW-09 FR-26 / FR-39)', () => {
    const now = new Date('2026-10-27T12:00:00.000Z');
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);
    const hour = 3_600_000;
    const day = 24 * hour;
    const empty = {
        openedByUserOnUpstream: [] as Date[],
        openedByUser: [] as Date[],
        openedOnUpstream: [] as Date[],
        openByUserOnUpstream: 0,
        maxOpen: 3,
        now,
    };

    it('allows a member with nothing in any window', () => {
        expect(evaluateUpstreamRateLimits(empty)).toBeNull();
    });

    it('refuses a second pull request on the same upstream within 24 hours, naming the limit and the next slot', () => {
        const opened = at(2 * hour);
        expect(
            evaluateUpstreamRateLimits({
                ...empty,
                openedByUserOnUpstream: [opened],
                openedByUser: [opened],
                openedOnUpstream: [opened],
            }),
        ).toEqual({
            code: 'rateLimited',
            limit: 'openedPerUpstreamPer24h',
            limitValue: 1,
            nextSlotAt: new Date(opened.getTime() + day).toISOString(),
        });
    });

    it('pins the window edge: 23:59:59 ago still counts, 24:00:01 ago does not', () => {
        const inside = at(day - 1_000);
        const outside = at(day + 1_000);
        expect(
            evaluateUpstreamRateLimits({ ...empty, openedByUserOnUpstream: [inside] })?.limit,
        ).toBe('openedPerUpstreamPer24h');
        expect(evaluateUpstreamRateLimits({ ...empty, openedByUserOnUpstream: [outside] })).toBeNull();
    });

    it.each([
        [1, 1, true],
        [3, 2, false],
        [3, 3, true],
        [10, 9, false],
        [10, 10, true],
        // The App spec cannot raise the cap past the ceiling of 10 (G15).
        [25, 10, true],
        [25, 9, false],
    ])('maxOpen %i with %i open refuses=%s (openPerUpstream, no nextSlotAt)', (maxOpen, open, refuses) => {
        const result = evaluateUpstreamRateLimits({ ...empty, maxOpen, openByUserOnUpstream: open });
        if (refuses) {
            expect(result).toEqual({
                code: 'rateLimited',
                limit: 'openPerUpstream',
                limitValue: Math.min(maxOpen, 10),
            });
        } else {
            expect(result).toBeNull();
        }
    });

    it('refuses a fourth pull request across all upstreams in 24 hours (default 3, CL-39)', () => {
        const opened = [at(5 * hour), at(3 * hour), at(hour)];
        const result = evaluateUpstreamRateLimits({ ...empty, openedByUser: opened });
        expect(result).toEqual({
            code: 'rateLimited',
            limit: 'openedOverallPer24h',
            limitValue: 3,
            nextSlotAt: new Date(opened[0].getTime() + day).toISOString(),
        });
        expect(evaluateUpstreamRateLimits({ ...empty, openedByUser: opened.slice(1) })).toBeNull();
    });

    it('honours the operator override of the overall limit', () => {
        const opened = [at(5 * hour), at(3 * hour), at(hour)];
        expect(
            evaluateUpstreamRateLimits({ ...empty, openedByUser: opened, limits: { openedOverallPer24h: 5 } }),
        ).toBeNull();
        // A malformed override falls back to the contract default rather than lifting the limit.
        expect(
            evaluateUpstreamRateLimits({ ...empty, openedByUser: opened, limits: { openedOverallPer24h: 0 } })
                ?.limit,
        ).toBe('openedOverallPer24h');
    });

    it('refuses on the platform-wide ceiling while the member’s own allowance remains (FR-39)', () => {
        const others = [at(10 * hour), at(8 * hour), at(6 * hour), at(4 * hour), at(2 * hour)];
        expect(evaluateUpstreamRateLimits({ ...empty, openedOnUpstream: others })).toEqual({
            code: 'platformCapReached',
            limit: 'platformOpenedPerUpstreamPer24h',
            limitValue: 5,
            nextSlotAt: new Date(others[0].getTime() + day).toISOString(),
        });
        expect(evaluateUpstreamRateLimits({ ...empty, openedOnUpstream: others.slice(1) })).toBeNull();
    });

    it('names the member limit first when both a member limit and the platform ceiling are full', () => {
        const others = [at(10 * hour), at(8 * hour), at(6 * hour), at(4 * hour), at(2 * hour)];
        expect(
            evaluateUpstreamRateLimits({
                ...empty,
                openedByUserOnUpstream: [others[4]],
                openedOnUpstream: others,
            })?.code,
        ).toBe('rateLimited');
    });

    it('with includesSelf, the caller’s own claim is not held against it — but a second one is', () => {
        const mine = at(1_000);
        expect(
            evaluateUpstreamRateLimits({
                ...empty,
                openedByUserOnUpstream: [mine],
                openedByUser: [mine],
                openedOnUpstream: [mine],
                openByUserOnUpstream: 1,
                includesSelf: true,
            }),
        ).toBeNull();
        const earlier = at(hour);
        const result = evaluateUpstreamRateLimits({
            ...empty,
            openedByUserOnUpstream: [earlier, mine],
            openedByUser: [earlier, mine],
            openedOnUpstream: [earlier, mine],
            openByUserOnUpstream: 2,
            includesSelf: true,
        });
        expect(result).toMatchObject({ code: 'rateLimited', limit: 'openedPerUpstreamPer24h' });
        expect(result?.nextSlotAt).toBe(new Date(earlier.getTime() + day).toISOString());
    });
});
