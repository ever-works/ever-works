import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    HOME_BLOCK_BUDGET_MS,
    HOME_BLOCK_IDS,
    HOME_CACHE_TTL_MS,
    type HomeBlock,
    type HomeBlockErrorKey,
    type HomeBlockId,
    type HomeGlance,
    type HomeSummaryDto,
} from '@ever-works/contracts';
import type { OwnershipScope } from '../database/ownership-scope';
import { UserNotificationPreferenceRepository } from '../database/repositories/user-notification-preference.repository';
import { HomeActivityBuilder } from './builders/activity.builder';
import { HomeDecisionsBuilder } from './builders/decisions.builder';
import { HomeRunsBuilder } from './builders/runs.builder';
import { HomeSpendBuilder } from './builders/spend.builder';
import { HomeTodayBuilder } from './builders/today.builder';
import { HomeSourceUnavailableError, type HomeBuildContext } from './home-build-context';
import { HomeSummaryCache } from './home-summary.cache';
import { buildHomeDay, resolveHomeTimezone } from './home-window';

export interface HomeSummaryRequest {
    /** The request's workspace scope, from the authenticated request only. */
    scope: OwnershipScope;
    /** An explicit IANA timezone (the browser's); omitted = the profile timezone, else UTC. */
    timezone?: string | null;
    /** Only these blocks; omitted or empty = every block. */
    blocks?: readonly HomeBlockId[] | null;
    /** Injected clock for tests. A pinned clock bypasses the micro-cache. */
    now?: Date;
}

class HomeBlockTimeoutError extends Error {
    constructor(block: HomeBlockId) {
        super(`Home block exceeded its budget: ${block}`);
        this.name = 'HomeBlockTimeoutError';
    }
}

/**
 * Home (AW-19) — composes the morning read.
 *
 * Home owns no data and writes nothing: every block is a builder over a
 * surface that already exists (My Decisions, the Runs ledger, the schedule
 * aggregation, the Costs summary, the Live Feed). Blocks run concurrently,
 * each against its own {@link HOME_BLOCK_BUDGET_MS} budget, and a builder
 * that throws, times out or is not wired reports `failed` with a message key
 * — never an empty list — while every other block still answers.
 *
 * A {@link HOME_CACHE_TTL_MS} per-process micro-cache keyed on the user, the
 * scope, the timezone and the block selection absorbs the double render of
 * a server page plus an immediate refresh.
 */
@Injectable()
export class HomeSummaryService {
    private readonly logger = new Logger(HomeSummaryService.name);
    private readonly cache = new HomeSummaryCache<HomeSummaryDto>(HOME_CACHE_TTL_MS);

    constructor(
        @Optional() private readonly decisions?: HomeDecisionsBuilder,
        @Optional() private readonly runs?: HomeRunsBuilder,
        @Optional() private readonly today?: HomeTodayBuilder,
        @Optional() private readonly spend?: HomeSpendBuilder,
        @Optional() private readonly activity?: HomeActivityBuilder,
        @Optional() private readonly notificationPreferences?: UserNotificationPreferenceRepository,
    ) {}

    async build(userId: string, request: HomeSummaryRequest): Promise<HomeSummaryDto> {
        const blocks = selectBlocks(request.blocks);
        const profileTimezone = request.timezone ? null : await this.profileTimezone(userId);
        // Throws InvalidHomeTimezoneError for an explicit unknown zone — the
        // caller's 400, decided before any block is read.
        const { timezone, fallback } = resolveHomeTimezone(request.timezone, profileTimezone);

        const cacheKey = [
            userId,
            request.scope.tenantId ?? '-',
            request.scope.organizationId ?? '-',
            timezone,
            blocks.join(','),
        ].join('|');
        if (!request.now) {
            const cached = this.cache.get(cacheKey);
            if (cached) return cached;
        }

        const now = request.now ?? new Date();
        const day = buildHomeDay(timezone, now);
        const context: HomeBuildContext = {
            userId,
            scope: request.scope,
            timezone,
            day: { date: day.date, from: new Date(day.from), to: new Date(day.to) },
            now,
            memo: new Map(),
        };

        const settled = await Promise.all(
            blocks.map(async (id) => [id, await this.runBlock(id, context)] as const),
        );

        const summary: HomeSummaryDto = {
            computedAt: now.toISOString(),
            timezone,
            timezoneFallback: fallback,
            day,
        };
        for (const [id, block] of settled) {
            (summary as unknown as Record<HomeBlockId, HomeBlock<unknown>>)[id] = block;
        }

        if (!request.now) this.cache.set(cacheKey, summary);
        return summary;
    }

    private loader(id: HomeBlockId, context: HomeBuildContext): () => Promise<unknown> {
        switch (id) {
            case 'needsYou':
                return () => required(this.decisions, 'decisions').build(context);
            case 'glance':
                return () => this.glance(context);
            case 'today':
                return () => required(this.today, 'schedules').build(context);
            case 'thisWeek':
                return () => required(this.spend, 'spend').build(context);
            case 'workingNow':
                return () => required(this.runs, 'runs').workingNow(context);
            case 'recentActivity':
                return () => required(this.activity, 'feed').build(context);
        }
    }

    private async glance(context: HomeBuildContext): Promise<HomeGlance> {
        const [needsYou, counters] = await Promise.all([
            required(this.decisions, 'decisions').openCount(context),
            required(this.runs, 'runs').counters(context),
        ]);
        return { needsYou, ...counters };
    }

    private async runBlock(
        id: HomeBlockId,
        context: HomeBuildContext,
    ): Promise<HomeBlock<unknown>> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new HomeBlockTimeoutError(id)), HOME_BLOCK_BUDGET_MS);
            timer.unref?.();
        });
        try {
            const data = await Promise.race([this.loader(id, context)(), timeout]);
            return { status: 'ok', data };
        } catch (error) {
            const errorKey = errorKeyOf(error);
            // The block name and the reason only — never the error text in the
            // response, and never user content in the log line.
            this.logger.warn(
                `Home block "${id}" failed (${errorKey}): ${error instanceof Error ? error.name : 'unknown'}`,
            );
            return { status: 'failed', errorKey, data: null };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async profileTimezone(userId: string): Promise<string | null> {
        if (!this.notificationPreferences) return null;
        try {
            const preference = await this.notificationPreferences.findByUser(userId);
            return preference?.timezone ?? null;
        } catch {
            // An unreadable profile timezone costs the local day, not the page.
            return null;
        }
    }
}

function required<T>(builder: T | undefined, source: string): T {
    if (!builder) throw new HomeSourceUnavailableError(source);
    return builder;
}

function errorKeyOf(error: unknown): HomeBlockErrorKey {
    if (error instanceof HomeBlockTimeoutError) return 'timeout';
    if (error instanceof HomeSourceUnavailableError) return 'unavailable';
    return 'error';
}

/** The asked-for blocks in display order; nothing asked for means every block. */
export function selectBlocks(blocks: readonly HomeBlockId[] | null | undefined): HomeBlockId[] {
    if (!blocks || blocks.length === 0) return [...HOME_BLOCK_IDS];
    const wanted = new Set<string>(blocks);
    return HOME_BLOCK_IDS.filter((id) => wanted.has(id));
}
