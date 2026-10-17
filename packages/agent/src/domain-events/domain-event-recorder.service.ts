import { Injectable } from '@nestjs/common';
import {
    DOMAIN_EVENT_PAYLOAD_VERSION,
    getDomainEventCatalogEntry,
    type DomainEventActor,
    type DomainEventAggregateType,
} from '@ever-works/contracts';
import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { Agent } from '../entities/agent.entity';
import { DomainEvent } from '../entities/domain-event.entity';
import { EmailMessage } from '../entities/email-message.entity';
import { InboxItem } from '../entities/inbox-item.entity';
import { MemoryFolder } from '../entities/memory-folder.entity';
import { Organization } from '../entities/organization.entity';
import { Task } from '../entities/task.entity';
import { Team } from '../entities/team.entity';
import { Work } from '../entities/work.entity';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { getDomainEventContext, normalizeSyncOrigin } from './domain-event-context';
import { newDomainEventId } from './domain-event-id';
import { DOMAIN_EVENTS_NOTIFY_CHANNEL } from './domain-events.config';

/** One state change to record (EW-P1-1, spec §3). */
export interface RecordDomainEventInput {
    /** A catalog v1 type; anything else is refused. */
    readonly type: string;
    readonly tenantId: string | null | undefined;
    readonly organizationId: string | null | undefined;
    readonly aggregate: {
        readonly type: DomainEventAggregateType;
        readonly id: string;
        /** The aggregate's version AFTER the change (see {@link DomainEventRecorder.bumpAggregateVersion}). */
        readonly version: number;
    };
    /** Full post-change snapshot in the integration DTO shape, or the child DTO. */
    readonly data: Record<string, unknown>;
    readonly changedFields?: readonly string[];
    /** Previous values of `changedFields` only. */
    readonly previous?: Record<string, unknown>;
    /** Defaults to the active {@link DomainEventContext} actor, then `system`. */
    readonly actor?: DomainEventActor;
    /** Defaults to the active context's `X-Sync-Origin`. */
    readonly originTag?: string | null;
    readonly integrationKeyId?: string | null;
    readonly correlationId?: string | null;
    /** The aggregate's visibility at event time; defaults to `data.visibility`. */
    readonly visibility?: string | null;
    readonly occurredAt?: Date;
}

/** The fallback actor of a change no request or job attributed. */
export const SYSTEM_ACTOR: DomainEventActor = { type: 'system', id: 'system', label: null };

/** The aggregates that carry a `version` column, by aggregate type (P1, then P2 as they record). */
const VERSIONED_AGGREGATES: Partial<Record<DomainEventAggregateType, EntityTarget<ObjectLiteral>>> =
    {
        task: Task,
        team: Team,
        agent: Agent,
        work: Work,
        organization: Organization,
        inbox_item: InboxItem,
        idea: WorkProposal,
        goal: Goal,
        mission: Mission,
        kb_document: WorkKnowledgeDocument,
        kb_folder: MemoryFolder,
        email_message: EmailMessage,
    };

/** Thrown for a type outside the catalog: an event nobody can parse is a bug, not data. */
export class UnknownDomainEventTypeError extends Error {
    constructor(type: string) {
        super(`"${type}" is not a domain event catalog v1 type`);
        this.name = 'UnknownDomainEventTypeError';
    }
}

/**
 * Records domain events into the `domain_events` outbox (EW-P1-1).
 *
 * Call it from a service-layer mutation **with the `EntityManager` of the
 * transaction that makes the change**, so the event commits or rolls back
 * with it. Given the default manager instead, the row is still written, but
 * not atomically with the change — wrap the mutation in
 * `dataSource.transaction(...)` at the recording point.
 *
 * On Postgres it also issues `pg_notify` inside the same transaction, so the
 * relay (which `LISTEN`s) wakes the moment the change commits; a rolled-back
 * transaction sends nothing.
 */
@Injectable()
export class DomainEventRecorder {
    async record(manager: EntityManager, input: RecordDomainEventInput): Promise<DomainEvent> {
        const entry = getDomainEventCatalogEntry(input.type);
        if (!entry) throw new UnknownDomainEventTypeError(input.type);

        const context = getDomainEventContext();
        const actor = input.actor ?? context?.actor ?? SYSTEM_ACTOR;
        const originTag =
            input.originTag !== undefined
                ? normalizeSyncOrigin(input.originTag)
                : (context?.originTag ?? null);
        const visibility =
            input.visibility !== undefined
                ? input.visibility
                : typeof input.data.visibility === 'string'
                  ? input.data.visibility
                  : null;

        const row = manager.getRepository(DomainEvent).create({
            id: newDomainEventId(),
            type: input.type,
            version: DOMAIN_EVENT_PAYLOAD_VERSION,
            tenantId: input.tenantId ?? null,
            organizationId: input.organizationId ?? null,
            aggregateType: input.aggregate.type,
            aggregateId: input.aggregate.id,
            aggregateVersion: input.aggregate.version,
            visibility,
            actorType: actor.type,
            actorId: actor.id || SYSTEM_ACTOR.id,
            actorLabel: actor.label ?? null,
            originTag,
            integrationKeyId: input.integrationKeyId ?? context?.integrationKeyId ?? null,
            changedFields: [...(input.changedFields ?? [])],
            data: input.data,
            previous: input.previous ?? {},
            occurredAt: input.occurredAt ?? new Date(),
            dispatchedAt: null,
            seq: null,
            correlationId: input.correlationId ?? context?.correlationId ?? null,
        });
        const saved = await manager.getRepository(DomainEvent).save(row);

        if (manager.connection.options.type === 'postgres') {
            await manager.query('SELECT pg_notify($1, $2)', [DOMAIN_EVENTS_NOTIFY_CHANNEL, '']);
        }
        return saved;
    }

    /**
     * Increment an aggregate's `version` (and, through TypeORM's
     * `@UpdateDateColumn`, its `updatedAt`) and return the new value. Call it in
     * the same transaction as the change and pass the result as
     * `aggregate.version`. Two concurrent writers serialize on the row lock this
     * update takes, which is what keeps one aggregate's events in order.
     *
     * Never call it for runtime-only writes (PR/CI/run state): those record
     * `task.runtime_updated` with the unchanged {@link readAggregateVersion}.
     */
    async bumpAggregateVersion(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
    ): Promise<number> {
        const target = this.versionedTarget(aggregateType);
        const escape = (name: string) => manager.connection.driver.escape(name);
        await manager
            .createQueryBuilder()
            .update(target)
            .set({ version: () => `${escape('version')} + 1` })
            .where(`${escape('id')} = :id`, { id })
            .execute();
        return this.readAggregateVersion(manager, aggregateType, id);
    }

    /** The aggregate's current `version` (1 when the row is gone). */
    async readAggregateVersion(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
    ): Promise<number> {
        const target = this.versionedTarget(aggregateType);
        const row = (await manager
            .getRepository(target)
            .createQueryBuilder('aggregate')
            .select('aggregate.version', 'version')
            .where('aggregate.id = :id', { id })
            .getRawOne()) as { version?: number | string } | undefined;
        const version = Number(row?.version ?? 1);
        return Number.isFinite(version) && version >= 1 ? version : 1;
    }

    private versionedTarget(aggregateType: DomainEventAggregateType): EntityTarget<ObjectLiteral> {
        const target = VERSIONED_AGGREGATES[aggregateType];
        if (!target) throw new Error(`Aggregate type "${aggregateType}" has no version column yet`);
        return target;
    }
}
