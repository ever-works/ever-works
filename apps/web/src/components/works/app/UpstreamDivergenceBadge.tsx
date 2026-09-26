'use client';

import { useTranslations } from 'next-intl';
import type { AppUpstreamDivergenceView } from '@ever-works/contracts';

/**
 * APW-02 T30 — the divergence line of the Upstream card (plan §5.2,
 * `plan.md:631-634`; spec §6.1, `spec.md:500-505`).
 *
 * ## Pure by construction
 *
 * The component reads counts and the reading's age and nothing else: no fetch,
 * no clock of its own (the "now" it ages against arrives as a prop, so a spec
 * pins the sentence instead of the wall clock), and no colour-only signal — the
 * counts and the checked time are **text** (spec §6.4, `spec.md:546-549`).
 *
 * ## The five messages
 *
 * Exactly the five of spec §6.1, chosen from the pair of counts and never from
 * a third value the API does not return:
 *
 * | ahead | behind | message          |
 * | ----- | ------ | ---------------- |
 * | 0     | 0      | `upToDate`       |
 * | 0     | > 0    | `behind`         |
 * | > 0   | 0      | `ahead`          |
 * | > 0   | > 0    | `aheadAndBehind` |
 * | —     | —      | `unknown`        |
 *
 * `unknown` is `divergence === null` — the row has no reading at all
 * (`plan.md:400`, `apps/api/src/app-works/app-upstream.controller.ts:72-101`
 * returns `divergence: null` until the first compare). A reading that exists but
 * is older than 10 minutes is **not** unknown: it renders with its age and
 * `stale` is what says it is old (FR-46, ACC-02-13).
 */
export interface UpstreamDivergenceBadgeProps {
    divergence: AppUpstreamDivergenceView | null;
    /**
     * The instant the age is measured against, **required**: the badge reads no
     * clock of its own, so it renders the same sentence on the server and on the
     * client, and a spec pins "Checked 6 minutes ago" instead of the wall clock
     * (`react-hooks/purity`, which rejects `Date.now()` in a render body — the
     * caller owns the reading and passes it down).
     */
    now: number;
}

/** The five message leaves, keyed by the case they render. */
export const UPSTREAM_DIVERGENCE_MESSAGE_KEYS = {
    upToDate: 'upToDate',
    behind: 'behind',
    ahead: 'ahead',
    aheadAndBehind: 'aheadAndBehind',
    unknown: 'unknown',
} as const;

export type UpstreamDivergenceMessageKey =
    (typeof UPSTREAM_DIVERGENCE_MESSAGE_KEYS)[keyof typeof UPSTREAM_DIVERGENCE_MESSAGE_KEYS];

/** Which of the five messages a reading renders, and the counts it interpolates. */
export interface UpstreamDivergenceMessage {
    key: UpstreamDivergenceMessageKey;
    /** `{ count }` for the two single-sided messages, `{ ahead, behind }` for the pair. */
    values?: Record<string, number>;
}

/**
 * Counts → the one message they render (spec §6.1). Negative counts cannot come
 * from the API (`plan.md:400` maps `ahead_by`/`behind_by` directly), and are
 * clamped rather than trusted: a negative would otherwise pick "behind" and
 * print `-1 commits behind upstream`.
 */
export function upstreamDivergenceMessage(
    divergence: AppUpstreamDivergenceView | null,
): UpstreamDivergenceMessage {
    if (!divergence) {
        return { key: UPSTREAM_DIVERGENCE_MESSAGE_KEYS.unknown };
    }

    const ahead = Math.max(0, divergence.aheadBy);
    const behind = Math.max(0, divergence.behindBy);

    if (ahead === 0 && behind === 0) {
        return { key: UPSTREAM_DIVERGENCE_MESSAGE_KEYS.upToDate };
    }
    if (ahead === 0) {
        return { key: UPSTREAM_DIVERGENCE_MESSAGE_KEYS.behind, values: { count: behind } };
    }
    if (behind === 0) {
        return { key: UPSTREAM_DIVERGENCE_MESSAGE_KEYS.ahead, values: { count: ahead } };
    }
    return { key: UPSTREAM_DIVERGENCE_MESSAGE_KEYS.aheadAndBehind, values: { ahead, behind } };
}

/**
 * `{ago}` for `Checked {ago}` (spec §6.1, `spec.md:505`).
 *
 * Provisional seam — **localisation of `{ago}`**: the plan fixes one leaf,
 * `appUpstream.checkedAgo`, with a `{ago}` parameter (`plan.md:857`) and names no
 * unit vocabulary, and `apps/web` has no relative-time formatter in use
 * anywhere (`useFormatter` has no caller). Until a unit-leaf set lands, the age
 * is the English sentence spec §6.1 shows verbatim — "Checked 6 minutes ago" —
 * and the leaf stays the single translation point for the sentence around it.
 */
export function formatUpstreamAge(computedAt: string, now: number): string {
    const at = Date.parse(computedAt);
    if (Number.isNaN(at)) {
        return 'recently';
    }

    const elapsedMs = Math.max(0, now - at);
    const minutes = Math.floor(elapsedMs / 60_000);

    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }

    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function UpstreamDivergenceBadge({ divergence, now }: UpstreamDivergenceBadgeProps) {
    const t = useTranslations('dashboard.workDetail.appUpstream');
    const message = upstreamDivergenceMessage(divergence);

    return (
        <p
            data-testid="app-upstream-badge"
            className="text-sm text-text-secondary dark:text-text-secondary-dark"
        >
            <span className="font-medium text-text dark:text-text-dark">
                {message.values ? t(message.key, message.values) : t(message.key)}
            </span>
            {divergence && (
                <span className="ml-2 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('checkedAgo', { ago: formatUpstreamAge(divergence.computedAt, now) })}
                </span>
            )}
        </p>
    );
}
