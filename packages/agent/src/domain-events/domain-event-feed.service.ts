import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
    matchesAnyDomainEventPattern,
    RECIPIENT_EVENT_VISIBILITY,
    recipientScopeForEventType,
    type DomainEventEnvelope,
} from '@ever-works/contracts';
import { DataSource } from 'typeorm';
import { DomainEvent } from '../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../entities/domain-event-relay-state.entity';
import { seqToBigInt, seqToString, toDomainEventEnvelope } from './domain-event-envelope';

/** What one feed page asks for (integration contract v1, B.2 `GET /events`). */
export interface DomainEventFeedQuery {
    /** The pinned organizations the caller may read. Empty → empty page. */
    readonly organizationIds: readonly string[];
    /** Return events with `seq` > `after` (`'0'` = from the start of retention). */
    readonly after: string;
    /** 1–1000, default 200. */
    readonly limit?: number;
    /** Catalog types / `<prefix>.*` / `*`; empty = everything except opt-in types. */
    readonly types?: readonly string[];
    /** Origin tags to leave out (the caller's own writes). */
    readonly excludeOrigins?: readonly string[];
    /**
     * The caller's granted scopes. Events of a recipient-scoped domain (one
     * person's messages: `inbox.*`, `email.*`) are served only when the
     * domain's read scope is among them (`recipientScopeForEventType`); absent
     * = none of those events.
     */
    readonly grantedScopes?: readonly string[];
}

export interface DomainEventFeedPage {
    readonly events: DomainEventEnvelope[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly head: string;
}

/** The cursor is older than the retention window: the consumer must resync (`410 cursor_expired`). */
export class DomainEventCursorExpiredError extends Error {
    constructor(
        readonly after: string,
        readonly floor: string,
    ) {
        super(`cursor ${after} is older than the retention floor ${floor}`);
        this.name = 'DomainEventCursorExpiredError';
    }
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
/** Rows scanned per round while filling one page (filters can drop rows). */
const SCAN_CHUNK = 500;
/** Upper bound of rows scanned for one page, so a selective filter cannot scan the whole table. */
const MAX_SCAN = 5000;

/**
 * Reads the change feed (EW-P1-1 storage, served by EW-P1-4's
 * `GET /api/integrations/v1/events`).
 *
 * Rules (integration contract v1, B.2):
 *  - only dispatched rows (`seq` set), in ascending `seq`, of the given orgs;
 *  - never personal scope (`organizationId` null);
 *  - never events of aggregates that were `private` at event time, EXCEPT
 *    `*.visibility_changed` to private (id-only data);
 *  - events of a recipient-scoped domain (`inbox.*`, `email.*`: one person's
 *    messages) only with that domain's read scope in `grantedScopes`;
 *  - `excludeOrigins` drops the caller's own writes (loop guard);
 *  - opt-in types (`task.runtime_updated`) only when named exactly;
 *  - `after` below the retention floor → {@link DomainEventCursorExpiredError}.
 *
 * `nextCursor` is the last SCANNED position, not the last returned one, so a
 * page that filtered rows out still moves the consumer forward; when nothing is
 * left for the caller's organizations it is the head itself.
 */
@Injectable()
export class DomainEventFeedService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async head(): Promise<string> {
        const state = await this.dataSource
            .getRepository(DomainEventRelayState)
            .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
        return seqToString(state?.lastSeq);
    }

    async readPage(query: DomainEventFeedQuery): Promise<DomainEventFeedPage> {
        // A non-finite limit (e.g. `Number('abc')` from a query string) falls back
        // to the default: NaN would make the page loop scan nothing and report
        // `hasMore` forever.
        const requested = Number.isFinite(query.limit)
            ? Math.trunc(query.limit as number)
            : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
        const after = seqToBigInt(query.after || '0');
        const state = await this.dataSource
            .getRepository(DomainEventRelayState)
            .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
        const head = seqToBigInt(state?.lastSeq);
        const floor = seqToBigInt(state?.retentionFloorSeq);
        if (after < floor) {
            throw new DomainEventCursorExpiredError(after.toString(), floor.toString());
        }
        if (query.organizationIds.length === 0) {
            return { events: [], nextCursor: null, hasMore: false, head: head.toString() };
        }

        const types = query.types?.filter((type) => type.length > 0) ?? [];
        const excluded = new Set(query.excludeOrigins ?? []);
        const granted = new Set(query.grantedScopes ?? []);
        const events: DomainEventEnvelope[] = [];
        let cursor = after;
        let scanned = 0;
        let exhausted = false;

        while (events.length < limit && scanned < MAX_SCAN) {
            const rows = await this.scan(query.organizationIds, cursor, head, SCAN_CHUNK);
            if (rows.length === 0) {
                exhausted = true;
                break;
            }
            for (const row of rows) {
                cursor = seqToBigInt(row.seq);
                scanned += 1;
                if (this.accepts(row, types, excluded, granted)) {
                    events.push(toDomainEventEnvelope(row));
                    if (events.length >= limit) break;
                }
            }
            if (rows.length < SCAN_CHUNK && events.length < limit) {
                exhausted = true;
                break;
            }
        }

        // Nothing left for these organizations up to the head read above: move the
        // consumer to the head, so a quiet organization's cursor keeps up with the
        // retention floor instead of expiring with nothing missed. Safe because every
        // position <= head was assigned and committed before `head` was read.
        if (exhausted && head > cursor) cursor = head;

        // Retention raises the floor BEFORE it deletes. If it ran while this page
        // was being scanned and passed `after`, rows this page should have
        // returned may be gone: answer 410 instead of a page with a silent hole.
        const floorAfterScan = seqToBigInt(
            (
                await this.dataSource
                    .getRepository(DomainEventRelayState)
                    .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } })
            )?.retentionFloorSeq,
        );
        if (after < floorAfterScan) {
            throw new DomainEventCursorExpiredError(after.toString(), floorAfterScan.toString());
        }
        const hasMore = !exhausted && cursor < head;
        const moved = cursor > after;
        return {
            events,
            nextCursor: moved ? cursor.toString() : null,
            hasMore,
            head: head.toString(),
        };
    }

    private accepts(
        row: DomainEvent,
        types: readonly string[],
        excluded: ReadonlySet<string>,
        granted: ReadonlySet<string>,
    ): boolean {
        if (row.originTag && excluded.has(row.originTag)) return false;
        // One person's messages (inbox, email): only with the domain's read
        // scope, whatever the row's visibility; a `recipient` row of a domain
        // with no such scope is never served.
        const recipientScope = recipientScopeForEventType(row.type);
        if (
            recipientScope
                ? !granted.has(recipientScope)
                : row.visibility === RECIPIENT_EVENT_VISIBILITY
        ) {
            return false;
        }
        const isPrivateNotice =
            row.type.endsWith('.visibility_changed') && row.visibility === 'private';
        if (row.visibility === 'private' && !isPrivateNotice) return false;
        if (types.length === 0) return matchesAnyDomainEventPattern(row.type, ['*']);
        return matchesAnyDomainEventPattern(row.type, types);
    }

    /** Rows of the given orgs in (after, head], in seq order — never past the head this page reports. */
    private scan(
        organizationIds: readonly string[],
        after: bigint,
        head: bigint,
        take: number,
    ): Promise<DomainEvent[]> {
        return this.dataSource
            .getRepository(DomainEvent)
            .createQueryBuilder('event')
            .where('event.seq IS NOT NULL')
            .andWhere('event.seq > :after', { after: after.toString() })
            .andWhere('event.seq <= :head', { head: head.toString() })
            .andWhere('event.organizationId IN (:...organizationIds)', {
                organizationIds: [...organizationIds],
            })
            .orderBy('event.seq', 'ASC')
            .take(take)
            .getMany();
    }
}
