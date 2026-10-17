import type {
    DomainEventAggregateType,
    DomainEventEnvelope,
    DomainEventType,
} from '@ever-works/contracts';
import type { DomainEvent } from '../entities/domain-event.entity';

/** A bigint column value (string on Postgres/MySQL, number on SQLite) as a decimal string. */
export function seqToString(value: string | number | bigint | null | undefined): string {
    if (value === null || value === undefined || value === '') return '0';
    return BigInt(value).toString();
}

/** A bigint column value as a `bigint`, for comparisons and arithmetic. */
export function seqToBigInt(value: string | number | bigint | null | undefined): bigint {
    return BigInt(seqToString(value));
}

function iso(value: Date | string | null | undefined): string {
    if (!value) return new Date(0).toISOString();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
}

/**
 * The published envelope (integration contract v1, B.3) of a DISPATCHED
 * outbox row. A row without a feed position has no envelope yet.
 */
export function toDomainEventEnvelope(row: DomainEvent): DomainEventEnvelope {
    if (row.seq === null || row.seq === undefined) {
        throw new Error(`domain event ${row.id} has no feed position yet`);
    }
    const envelope: DomainEventEnvelope = {
        id: row.id,
        seq: seqToString(row.seq),
        type: row.type as DomainEventType,
        version: Number(row.version) || 1,
        occurredAt: iso(row.occurredAt),
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
        aggregate: {
            type: row.aggregateType as DomainEventAggregateType,
            id: row.aggregateId,
            version: Number(row.aggregateVersion) || 1,
        },
        actor: {
            type: row.actorType as DomainEventEnvelope['actor']['type'],
            id: row.actorId,
            label: row.actorLabel ?? null,
        },
        origin: { tag: row.originTag ?? null, integrationKeyId: row.integrationKeyId ?? null },
        changedFields: Array.isArray(row.changedFields) ? row.changedFields : [],
        data: row.data ?? {},
        previous: row.previous ?? {},
    };
    if (row.correlationId) {
        return { ...envelope, correlationId: row.correlationId };
    }
    return envelope;
}
