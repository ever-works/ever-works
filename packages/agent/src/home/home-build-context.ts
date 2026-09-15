import type { OwnershipScope } from '../database/ownership-scope';

/**
 * Home (AW-19) — what every block builder receives for one summary build.
 *
 * `memo` lets two blocks that read the same source (the decision page feeds
 * both Needs you and the glance counter; the running Runs feed both Working
 * now and the glance counter) share one read inside a single build.
 */
export interface HomeBuildContext {
    userId: string;
    /** The request's workspace scope, from the authenticated request. */
    scope: OwnershipScope;
    timezone: string;
    /** The local calendar day, as instants. */
    day: { date: string; from: Date; to: Date };
    now: Date;
    memo: Map<string, Promise<unknown>>;
}

/** Run `load` once per build for `key`; later callers share the same promise. */
export function memoizeInBuild<T>(
    context: HomeBuildContext,
    key: string,
    load: () => Promise<T>,
): Promise<T> {
    const existing = context.memo.get(key);
    if (existing) return existing as Promise<T>;
    const pending = load();
    context.memo.set(key, pending);
    return pending;
}

/**
 * A block's source is not wired in this deployment (an optional provider is
 * absent). Reported as the block's `unavailable` failure, never as an empty
 * block — an unbound source must not look like a quiet morning.
 */
export class HomeSourceUnavailableError extends Error {
    constructor(source: string) {
        super(`Home source not available: ${source}`);
        this.name = 'HomeSourceUnavailableError';
    }
}
