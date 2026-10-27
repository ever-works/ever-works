import { createHash } from 'crypto';
import {
    FLEET_USAGE_ZERO_TOKENS,
    addFleetUsageTokens,
    isFleetUsageOtherFolder,
    maxFleetUsageTokens,
    type FleetSessionModelUsage,
    type FleetSessionUsage,
    type FleetUsageProvider,
    type FleetUsageRow,
    type FleetUsageTokens,
} from '@ever-works/contracts';
import type { ModelListPrices } from '../../usage/model-list-prices';

/**
 * Usage & cost on the fleet (FL-20) — the pure arithmetic every writer and
 * reader of `fleet_usage_samples` shares: the bucket identity, the merge rule
 * and the pricing of summed tokens. No I/O; the reconciler and the view
 * service call it, the specs drive it directly.
 */

/** A sample row's identity, as the unique `dedupeKey` (sha256, 64 hex). */
export function fleetUsageDedupeKey(input: {
    nodeId: string;
    bucketStart: string;
    provider: FleetUsageProvider;
    model: string;
    providerSessionId: string | null;
    folderBucket: string | null;
}): string {
    return createHash('sha256')
        .update(
            [
                input.nodeId,
                input.bucketStart,
                input.provider,
                input.model,
                input.providerSessionId ?? '',
                input.folderBucket ?? '',
            ].join('\u0000'),
        )
        .digest('hex');
}

/** The `checkoutPath` a row's folder bucket is stored as: the path, or null for "other folders". */
export function fleetUsageCheckoutPath(folderBucket: string | null): string | null {
    if (!folderBucket || isFleetUsageOtherFolder(folderBucket)) return null;
    return folderBucket;
}

/** A `bigint` column read off either driver (a string on Postgres, a number on sqlite). */
export function bigintCount(value: unknown): number {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The token columns of a stored sample. */
export function sampleTokens(sample: {
    inputTokens: unknown;
    outputTokens: unknown;
    cacheReadTokens: unknown;
    cacheWriteTokens: unknown;
}): FleetUsageTokens {
    return {
        in: bigintCount(sample.inputTokens),
        out: bigintCount(sample.outputTokens),
        cacheRead: bigintCount(sample.cacheReadTokens),
        cacheWrite: bigintCount(sample.cacheWriteTokens),
    };
}

/** What one merge produces for a bucket: the field-wise maximum, never a sum (FR-4, U4, U5). */
export interface MergedBucket {
    tokens: FleetUsageTokens;
    requests: number;
    firstAt: Date;
    lastAt: Date;
    /** True when anything grew — an unchanged re-send writes nothing. */
    changed: boolean;
}

export function mergeBucket(
    stored: {
        tokens: FleetUsageTokens;
        requests: number;
        firstAt: Date | null;
        lastAt: Date | null;
    } | null,
    row: FleetUsageRow,
): MergedBucket {
    const rowFirst = new Date(row.firstAt);
    const rowLast = new Date(row.lastAt);
    if (!stored) {
        return {
            tokens: { ...row.tokens },
            requests: row.requests,
            firstAt: rowFirst,
            lastAt: rowLast,
            changed: true,
        };
    }
    const tokens = maxFleetUsageTokens(stored.tokens, row.tokens);
    const requests = Math.max(stored.requests, row.requests);
    const firstAt =
        stored.firstAt && stored.firstAt.getTime() <= rowFirst.getTime()
            ? stored.firstAt
            : rowFirst;
    const lastAt =
        stored.lastAt && stored.lastAt.getTime() >= rowLast.getTime() ? stored.lastAt : rowLast;
    const changed =
        tokens.in !== stored.tokens.in ||
        tokens.out !== stored.tokens.out ||
        tokens.cacheRead !== stored.tokens.cacheRead ||
        tokens.cacheWrite !== stored.tokens.cacheWrite ||
        requests !== stored.requests ||
        firstAt !== stored.firstAt ||
        lastAt !== stored.lastAt;
    return { tokens, requests, firstAt, lastAt, changed };
}

/** One (model, price-list version) group of summed tokens — the unit every aggregate prices. */
export interface UsageGroup {
    model: string;
    provider: FleetUsageProvider;
    /** The version the group's samples were priced at; null = never priced (tokens only). */
    priceListVersion: number | null;
    tokens: FleetUsageTokens;
    requests: number;
    firstAt?: Date | null;
    lastAt?: Date | null;
}

/** One model's summed figures after pricing. */
export interface PricedModel {
    model: string;
    provider: FleetUsageProvider;
    tokens: FleetUsageTokens;
    requests: number;
    /** Fractional cents of the PRICED part; null when no group of this model could be priced. */
    cents: number | null;
}

export interface PricedUsage {
    byModel: PricedModel[];
    /** Rounded once, over the priced models only; null when nothing was priced. */
    costCents: number | null;
    /** Fractional cents before rounding (for summing several aggregates honestly). */
    cents: number;
    unknownModels: string[];
    unknownRequests: number;
    tokens: FleetUsageTokens;
    requests: number;
    versionsUsed: number[];
    firstAt: Date | null;
    lastAt: Date | null;
}

/**
 * Price summed groups (lane log decision 6): each group at ITS version (a
 * figure is never re-priced silently, U8; a group never priced uses the
 * current version), summed per model, rounded ONCE. A model the list does not
 * know is tokens only and excluded from every dollar figure (FR-8).
 */
export function priceUsageGroups(
    groups: readonly UsageGroup[],
    prices: ModelListPrices,
): PricedUsage {
    const byModel = new Map<string, PricedModel>();
    const unknown = new Map<string, number>();
    const versions = new Set<number>();
    let tokens: FleetUsageTokens = { ...FLEET_USAGE_ZERO_TOKENS };
    let requests = 0;
    let cents = 0;
    let anyPriced = false;
    let firstAt: Date | null = null;
    let lastAt: Date | null = null;
    for (const group of groups) {
        tokens = addFleetUsageTokens(tokens, group.tokens);
        requests += group.requests;
        if (group.firstAt && (!firstAt || group.firstAt < firstAt)) firstAt = group.firstAt;
        if (group.lastAt && (!lastAt || group.lastAt > lastAt)) lastAt = group.lastAt;
        const version = group.priceListVersion ?? prices.currentVersion;
        const priced = prices.price(group.tokens, group.model, version);
        const line = byModel.get(group.model) ?? {
            model: group.model,
            provider: group.provider,
            tokens: { ...FLEET_USAGE_ZERO_TOKENS },
            requests: 0,
            cents: null,
        };
        line.tokens = addFleetUsageTokens(line.tokens, group.tokens);
        line.requests += group.requests;
        if (priced) {
            line.cents = (line.cents ?? 0) + priced.cents;
            cents += priced.cents;
            anyPriced = true;
            versions.add(priced.version);
        } else {
            unknown.set(group.model, (unknown.get(group.model) ?? 0) + group.requests);
        }
        byModel.set(group.model, line);
    }
    let unknownRequests = 0;
    for (const value of unknown.values()) unknownRequests += value;
    return {
        byModel: [...byModel.values()].sort(
            (a, b) => (b.cents ?? -1) - (a.cents ?? -1) || b.requests - a.requests,
        ),
        costCents: anyPriced ? Math.round(cents) : null,
        cents,
        unknownModels: [...unknown.keys()].sort(),
        unknownRequests,
        tokens,
        requests,
        versionsUsed: [...versions].sort((a, b) => a - b),
        firstAt,
        lastAt,
    };
}

/** `fleet_sessions.tokens` from a Session's priced usage. */
export function toFleetSessionUsage(priced: PricedUsage, now: Date): FleetSessionUsage {
    const byModel: Record<string, FleetSessionModelUsage> = {};
    for (const line of priced.byModel) {
        byModel[line.model] = {
            ...line.tokens,
            requests: line.requests,
            costCents: line.cents === null ? null : Math.round(line.cents * 100) / 100,
        };
    }
    return {
        byModel,
        priceListVersion:
            priced.versionsUsed.length > 0
                ? priced.versionsUsed[priced.versionsUsed.length - 1]
                : null,
        unknownModels: priced.unknownModels,
        requests: priced.requests,
        firstAt: priced.firstAt ? priced.firstAt.toISOString() : null,
        lastAt: priced.lastAt ? priced.lastAt.toISOString() : null,
        updatedAt: now.toISOString(),
    };
}
