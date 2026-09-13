import { Injectable } from '@nestjs/common';
import {
    FEED_ACTORS_WINDOW_HOURS_DEFAULT,
    FEED_ACTORS_WINDOW_HOURS_MAX,
    FEED_HISTORY_DAYS,
    FEED_MAX_AGENT_FILTER,
    FEED_PAGE_SIZE_DEFAULT,
    FEED_PAGE_SIZE_MAX,
    type FeedActorSummaryDto,
    type FeedActorsDto,
    type FeedEntryDto,
    type FeedPageDto,
} from '@ever-works/contracts';
import { ActivityLogRepository } from '../database/repositories/activity-log.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import type { ActivityLog } from '../entities/activity-log.entity';
import { actorAgentIdOf, isUuid, resolveFeedActor, type FeedAgentRef } from './feed-actor';
import { buildFeedKindSets, normalizeFeedKinds, resolveFeedKind } from './feed-kind';
import { narrate } from './feed-narration';
import { resolveFeedTarget } from './feed-target';

/** Filters a Live Feed page accepts. All optional. */
export interface FeedPageQuery {
    agentIds?: readonly string[];
    kinds?: readonly string[];
    failedOnly?: boolean;
    /** Opaque cursor from a previous page's `nextCursor`. */
    cursor?: string | null;
    limit?: number;
}

/** A cursor that does not decode. The client drops it and reloads page one. */
export class FeedInvalidCursorError extends Error {
    readonly code = 'invalid-cursor' as const;

    constructor() {
        super('The feed cursor is invalid.');
        this.name = 'FeedInvalidCursorError';
    }
}

/** More agents than may be watched at once — refused, never truncated. */
export class FeedTooManyAgentsError extends Error {
    readonly code = 'too-many-agents' as const;
    readonly max = FEED_MAX_AGENT_FILTER;

    constructor() {
        super(`At most ${FEED_MAX_AGENT_FILTER} agents can be watched at once.`);
        this.name = 'FeedTooManyAgentsError';
    }
}

const CURSOR_MAX_LENGTH = 256;
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Upper bound on roster rows, so one user with many agents stays one bounded read. */
const ROSTER_LIMIT = 200;

/** The kind sets never change at runtime; build them once. */
const KIND_SETS = buildFeedKindSets();

/** `{ createdAt, id }` → opaque base64url cursor. */
export function encodeFeedCursor(position: { createdAt: string; id: string }): string {
    return Buffer.from(JSON.stringify({ t: position.createdAt, i: position.id }), 'utf8').toString(
        'base64url',
    );
}

/** Opaque cursor → `{ createdAt, id }`, or {@link FeedInvalidCursorError}. */
export function decodeFeedCursor(cursor: string): { createdAt: string; id: string } {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH) {
        throw new FeedInvalidCursorError();
    }
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new FeedInvalidCursorError();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        throw new FeedInvalidCursorError();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new FeedInvalidCursorError();
    }
    const { t, i } = parsed as { t?: unknown; i?: unknown };
    if (typeof t !== 'string' || !CURSOR_TIMESTAMP.test(t) || !isUuid(i)) {
        throw new FeedInvalidCursorError();
    }
    const asDate = new Date(t.endsWith('Z') ? t : `${t}Z`);
    if (Number.isNaN(asDate.getTime())) {
        throw new FeedInvalidCursorError();
    }
    return { createdAt: t, id: i };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Live Feed — the read model over the activity log.
 *
 * Reads existing activity records and returns them as narrated entries. It
 * writes nothing (spec FR-3 / FR-57): no feed-only store, no record of its
 * own opening. Every read is bounded by the owner AND the request's ownership
 * scope, both supplied by the caller from the authenticated request — there
 * is no parameter through which one user reads another user's feed.
 */
@Injectable()
export class FeedService {
    constructor(
        private readonly activityLogs: ActivityLogRepository,
        private readonly agents: AgentRepository,
    ) {}

    async getPage(
        userId: string,
        ownershipScope: OwnershipScope,
        query: FeedPageQuery = {},
        now: Date = new Date(),
    ): Promise<FeedPageDto> {
        const agentIds = [...new Set(query.agentIds ?? [])];
        if (agentIds.length > FEED_MAX_AGENT_FILTER) {
            throw new FeedTooManyAgentsError();
        }
        const validAgentIds = agentIds.filter(isUuid);
        if (agentIds.length > 0 && validAgentIds.length === 0) {
            // Every requested agent id is malformed — nothing can match.
            return this.emptyPage(now);
        }

        const cursor = query.cursor ? decodeFeedCursor(query.cursor) : undefined;
        const limit = clamp(query.limit, FEED_PAGE_SIZE_DEFAULT, 1, FEED_PAGE_SIZE_MAX);
        const since = new Date(now.getTime() - FEED_HISTORY_DAYS * DAY_MS);
        const kinds = normalizeFeedKinds(query.kinds, query.failedOnly === true);

        const page = await this.activityLogs.findFeedPage(
            {
                userId,
                agentIds: validAgentIds.length > 0 ? validAgentIds : undefined,
                kindFilter: kinds ? { kinds, sets: KIND_SETS } : undefined,
                cursor,
                since,
                limit,
            },
            ownershipScope,
        );

        const agents = await this.loadAgents(userId, page.rows);
        const items = page.rows.map((row) => this.toEntry(row, agents));
        const last = page.rows[page.rows.length - 1];
        const lastKey = last ? page.sortKeys.get(last.id) : undefined;
        const nextCursor =
            page.hasMore && last && lastKey
                ? encodeFeedCursor({ createdAt: lastKey, id: last.id })
                : null;

        return {
            items,
            nextCursor,
            hasMore: nextCursor !== null,
            historyFloor: since.toISOString(),
        };
    }

    /**
     * The agent roster for the filter bar: every agent in the active scope
     * plus any agent with activity in the window, busiest first.
     */
    async getActors(
        userId: string,
        ownershipScope: OwnershipScope,
        windowHours?: number,
        now: Date = new Date(),
    ): Promise<FeedActorsDto> {
        const hours = clamp(
            windowHours,
            FEED_ACTORS_WINDOW_HOURS_DEFAULT,
            1,
            FEED_ACTORS_WINDOW_HOURS_MAX,
        );
        const since = new Date(now.getTime() - hours * HOUR_MS);

        const [scoped, counts] = await Promise.all([
            this.agents.findByUserIdScoped(userId, { limit: ROSTER_LIMIT }, ownershipScope),
            this.activityLogs.aggregateFeedActors(userId, ownershipScope, since, ROSTER_LIMIT),
        ]);

        const countById = new Map(counts.map((entry) => [entry.agentId, entry]));
        const known = new Map(scoped.rows.map((agent) => [agent.id, agent]));
        const missing = counts.map((entry) => entry.agentId).filter((id) => !known.has(id));
        if (missing.length > 0) {
            // An agent with activity in this scope that the catalog query no
            // longer lists (for example archived). Deleted agents do not come
            // back and are left out.
            for (const agent of await this.agents.findManyByIdsForUser(userId, missing)) {
                known.set(agent.id, agent);
            }
        }

        const actors: FeedActorSummaryDto[] = [...known.values()].map((agent) => {
            const count = countById.get(agent.id);
            return {
                agentId: agent.id,
                label: agent.name,
                status: agent.status,
                avatarMode: agent.avatarMode ?? null,
                count: count?.count ?? 0,
                lastActivityAt: count?.lastActivityAt ?? null,
            };
        });

        actors.sort(
            (a, b) =>
                b.count - a.count ||
                (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
                a.label.localeCompare(b.label),
        );

        return { actors, windowHours: hours };
    }

    private emptyPage(now: Date): FeedPageDto {
        return {
            items: [],
            nextCursor: null,
            hasMore: false,
            historyFloor: new Date(now.getTime() - FEED_HISTORY_DAYS * DAY_MS).toISOString(),
        };
    }

    /** One batched lookup for every agent the page refers to. */
    private async loadAgents(
        userId: string,
        rows: ActivityLog[],
    ): Promise<Map<string, FeedAgentRef>> {
        const ids = new Set<string>();
        for (const row of rows) {
            const id = actorAgentIdOf(row);
            if (id) ids.add(id);
        }
        if (ids.size === 0) return new Map();
        const agents = await this.agents.findManyByIdsForUser(userId, [...ids]);
        return new Map(
            agents.map((agent) => [
                agent.id,
                { id: agent.id, name: agent.name, avatarMode: agent.avatarMode ?? null },
            ]),
        );
    }

    private toEntry(row: ActivityLog, agents: ReadonlyMap<string, FeedAgentRef>): FeedEntryDto {
        const actor = resolveFeedActor(row, agents);
        const agentStillExists =
            actor.kind === 'agent' && !!actor.agentId && agents.has(actor.agentId);
        return {
            id: row.id,
            createdAt: new Date(row.createdAt).toISOString(),
            kind: resolveFeedKind(row.actionType, row.status),
            status: row.status,
            actionType: row.actionType,
            actor,
            narration: narrate(row, actor.label),
            target: resolveFeedTarget(row, actor, agentStillExists),
            workId: row.workId ?? null,
        };
    }
}
