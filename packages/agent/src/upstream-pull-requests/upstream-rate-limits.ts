import {
    UPSTREAM_LIMITS,
    UPSTREAM_LIMIT_WINDOW_MS,
    type UpstreamRateLimitKey,
} from '@ever-works/contracts';

/**
 * APW-09 T8 — FR-26 / FR-27 / FR-39 rate limits, as a pure function.
 *
 * The caller reads the windows (`openedAt` of the rows inside the last 24 hours, oldest
 * first) and the open-at-once count; this decides. Pure on purpose: the boundaries
 * (`23:59:59` vs `24:00:01`), the clamp of the App spec's `maxOpen` against the ceiling and
 * the platform ceiling refusing while the member's own allowance remains are all provable
 * without a database.
 *
 * ## The order of the checks
 *
 * Member limits first, then the platform ceiling: when both are full, the member is told
 * the one they can act on. `openPerUpstream` carries no `nextSlotAt` — a slot opens when a
 * pull request there merges or closes, not after a fixed time (spec §6.5).
 *
 * ## `includesSelf`
 *
 * The direct route claims its record (stamping `openedAt`) and then re-evaluates with the
 * claim counted, so two concurrent requests cannot both pass a pre-check. With
 * `includesSelf: true` a window refuses only when it holds MORE than the limit.
 */

/** The windows and counts one evaluation reads. Every list is `openedAt`, oldest first. */
export interface UpstreamRateLimitInput {
    /** This member's pull requests on this upstream in the last 24 hours. */
    readonly openedByUserOnUpstream: readonly Date[];
    /** This member's pull requests anywhere in the last 24 hours. */
    readonly openedByUser: readonly Date[];
    /** Every pull request Ever Works opened on this upstream in the last 24 hours (FR-39). */
    readonly openedOnUpstream: readonly Date[];
    /** This member's pull requests on this upstream still `opening` / `open`. */
    readonly openByUserOnUpstream: number;
    /** The App Work's effective open-at-once cap (`effectiveUpstreamMaxOpen(spec.maxOpen)`). */
    readonly maxOpen: number;
    /** Operator overrides (R-31); every value only narrows or raises within its own bound. */
    readonly limits?: {
        readonly openedPerUpstreamPer24h?: number;
        readonly openedOverallPer24h?: number;
        readonly platformOpenedPerUpstreamPer24h?: number;
    };
    readonly includesSelf?: boolean;
    readonly now?: Date;
}

export interface UpstreamRateLimitRefusal {
    /** `rateLimited` for FR-26, `platformCapReached` for FR-39. */
    readonly code: 'rateLimited' | 'platformCapReached';
    readonly limit: UpstreamRateLimitKey;
    /** The limit's value, for the `{count}` placeholder. */
    readonly limitValue: number;
    /** ISO; absent for `openPerUpstream`. */
    readonly nextSlotAt?: string;
}

/** `null` = allowed. */
export function evaluateUpstreamRateLimits(
    input: UpstreamRateLimitInput,
): UpstreamRateLimitRefusal | null {
    const now = input.now ?? new Date();
    const self = input.includesSelf === true ? 1 : 0;
    const limits = {
        openedPerUpstreamPer24h: positive(
            input.limits?.openedPerUpstreamPer24h,
            UPSTREAM_LIMITS.openedPerUpstreamPer24h,
        ),
        openedOverallPer24h: positive(
            input.limits?.openedOverallPer24h,
            UPSTREAM_LIMITS.openedOverallPer24h,
        ),
        platformOpenedPerUpstreamPer24h: positive(
            input.limits?.platformOpenedPerUpstreamPer24h,
            UPSTREAM_LIMITS.platformOpenedPerUpstreamPer24h,
        ),
    };
    const maxOpen = Math.max(
        1,
        Math.min(
            Number.isFinite(input.maxOpen) ? Math.trunc(input.maxOpen) : 1,
            UPSTREAM_LIMITS.openPerUpstreamCeiling,
        ),
    );

    const perUpstream = windowRefusal(
        input.openedByUserOnUpstream,
        limits.openedPerUpstreamPer24h,
        self,
        now,
    );
    if (perUpstream) {
        return {
            code: 'rateLimited',
            limit: 'openedPerUpstreamPer24h',
            limitValue: limits.openedPerUpstreamPer24h,
            nextSlotAt: perUpstream,
        };
    }

    if (input.openByUserOnUpstream - self >= maxOpen) {
        return { code: 'rateLimited', limit: 'openPerUpstream', limitValue: maxOpen };
    }

    const overall = windowRefusal(input.openedByUser, limits.openedOverallPer24h, self, now);
    if (overall) {
        return {
            code: 'rateLimited',
            limit: 'openedOverallPer24h',
            limitValue: limits.openedOverallPer24h,
            nextSlotAt: overall,
        };
    }

    const platform = windowRefusal(
        input.openedOnUpstream,
        limits.platformOpenedPerUpstreamPer24h,
        self,
        now,
    );
    if (platform) {
        return {
            code: 'platformCapReached',
            limit: 'platformOpenedPerUpstreamPer24h',
            limitValue: limits.platformOpenedPerUpstreamPer24h,
            nextSlotAt: platform,
        };
    }

    return null;
}

/**
 * The ISO time the window frees a slot, or `null` when it is not full.
 *
 * Only entries strictly inside the last 24 hours count (an entry exactly 24 hours old has
 * left the window). With `n` entries and a limit of `l`, the window is full when
 * `n - self >= l`, and the next slot opens when the `(n - l + 1 - self)`-th oldest entry
 * leaves it.
 */
function windowRefusal(
    entries: readonly Date[],
    limit: number,
    self: number,
    now: Date,
): string | null {
    const cutoff = now.getTime() - UPSTREAM_LIMIT_WINDOW_MS;
    const inside = entries
        .map((entry) => new Date(entry).getTime())
        .filter((at) => Number.isFinite(at) && at > cutoff)
        .sort((a, b) => a - b);
    const others = inside.length - self;
    if (others < limit) return null;
    const freeing = inside[Math.max(0, inside.length - limit - self)] ?? inside[0];
    return new Date(freeing + UPSTREAM_LIMIT_WINDOW_MS).toISOString();
}

function positive(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
