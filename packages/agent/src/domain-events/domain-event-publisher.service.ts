import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DomainEventActor, DomainEventAggregateType } from '@ever-works/contracts';
import { DataSource, type EntityManager } from 'typeorm';
import { serializeOnSingleConnection } from '../database/repositories/single-connection-write-queue';
import {
    assertExpectedAggregateVersion,
    takeClaimedAggregateVersion,
} from './domain-event-context';
import { DomainEventRecorder } from './domain-event-recorder.service';
import { buildKbDocumentSnapshot, buildKbFolderSnapshot } from './domain-event-kb-snapshots';
import { buildEmailMessageSnapshot } from './domain-event-email-snapshots';
import {
    type AggregateSnapshot,
    buildAgentSnapshot,
    buildGoalSnapshot,
    buildInboxItemSnapshot,
    buildIdeaSnapshot,
    buildMissionSnapshot,
    buildOrganizationSnapshot,
    buildTaskSnapshot,
    buildTeamSnapshot,
    buildWorkSnapshot,
} from './domain-event-snapshots';

/** Options every recording takes. */
export interface PublishOptions {
    readonly changedFields?: readonly string[];
    readonly previous?: Record<string, unknown>;
    /** Overrides the request context's actor (e.g. a cron's system actor). */
    readonly actor?: DomainEventActor;
    /**
     * Child events only: the event's visibility instead of the parent's. `'private'`
     * keeps it off the integration feed and webhooks v2, e.g. a Team's
     * `team.resource.*` link to a private record (review 2026-10-17 F4).
     */
    readonly visibility?: string | null;
}

type Builder = (manager: EntityManager, id: string) => Promise<AggregateSnapshot<object> | null>;

const BUILDERS: Partial<Record<DomainEventAggregateType, Builder>> = {
    task: buildTaskSnapshot,
    team: buildTeamSnapshot,
    agent: buildAgentSnapshot,
    work: buildWorkSnapshot,
    organization: buildOrganizationSnapshot,
    inbox_item: buildInboxItemSnapshot,
    idea: buildIdeaSnapshot,
    goal: buildGoalSnapshot,
    mission: buildMissionSnapshot,
    // EW-P3-2 — Knowledge Base documents and organization library folders.
    kb_document: buildKbDocumentSnapshot,
    kb_folder: buildKbFolderSnapshot,
    // EW-P4-2 — agent email (recipient-scoped).
    email_message: buildEmailMessageSnapshot,
};

/** A full snapshot taken BEFORE a hard delete, to record the tombstone after it. */
export interface AggregateTombstone {
    readonly aggregateType: DomainEventAggregateType;
    readonly id: string;
    readonly snapshot: AggregateSnapshot<object>;
}

/**
 * Records P1 domain events at the service-layer recording points (EW-P1-1 B2,
 * `docs/specs/features/domain-events/spec.md` §3–4).
 *
 * Every method takes the `EntityManager` of the transaction that makes the
 * change: the aggregate's `version` bump, its post-change snapshot and the
 * outbox row all commit (or roll back) with it. Services that are not
 * transactional today wrap their write and the recording in
 * {@link DomainEventPublisher.transaction}.
 *
 * Injected `@Optional()` everywhere, so a graph without it (unit tests, the
 * worker) keeps today's behaviour exactly.
 */
@Injectable()
export class DomainEventPublisher {
    constructor(
        readonly recorder: DomainEventRecorder,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    /**
     * Run `fn` in a transaction (the write and its event together). On
     * better-sqlite3, where a whole DataSource shares ONE connection and
     * overlapping transactions nest as savepoints, the transaction is queued
     * behind the platform's other serialized writes. Never call it from
     * inside another queued unit of work (it would wait on itself).
     */
    transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
        return serializeOnSingleConnection(this.dataSource.manager, () =>
            this.dataSource.transaction(fn),
        );
    }

    /**
     * A full-snapshot event (`<x>.created`, `<x>.updated`, `<x>.transitioned`,
     * `<x>.status_changed`, `<x>.archived`): bump the version, snapshot, record.
     * Returns the new version (callers that return the written entity set it),
     * or `null` when the row no longer exists and nothing was recorded.
     */
    async changed(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
        type: string,
        options: PublishOptions = {},
    ): Promise<number | null> {
        const builder = this.builderFor(aggregateType);
        // An If-Match write that claimed its version first (a compare-and-set
        // on `version`, see `runWithClaimedAggregateVersion`) is not bumped twice.
        const claimed = takeClaimedAggregateVersion(aggregateType, id);
        const version =
            claimed ?? (await this.recorder.bumpAggregateVersion(manager, aggregateType, id));
        if (claimed === null) assertExpectedAggregateVersion(aggregateType, id, version);
        const snapshot = await builder(manager, id);
        if (!snapshot) return null;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: aggregateType, id, version },
            data: snapshot.dto as Record<string, unknown>,
            changedFields: options.changedFields,
            previous: options.previous,
            actor: options.actor,
            visibility: snapshot.visibility,
        });
        return version;
    }

    /**
     * `<x>.created`: snapshot and record WITHOUT bumping — a new aggregate's
     * first event carries version 1. Call it after the row (and any edges
     * written in the same transaction) exist.
     */
    async created(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
        type: string,
        options: PublishOptions = {},
    ): Promise<void> {
        const snapshot = await this.builderFor(aggregateType)(manager, id);
        if (!snapshot) return;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: {
                type: aggregateType,
                id,
                version: Number((snapshot.dto as { version?: number }).version) || 1,
            },
            data: snapshot.dto as Record<string, unknown>,
            actor: options.actor,
            visibility: snapshot.visibility,
        });
    }

    /**
     * A child event (`task.assignee.added`, `team.member.removed`, …): bump the
     * PARENT's version and record the child DTO with it.
     */
    async child(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        parentId: string,
        type: string,
        data: Record<string, unknown>,
        options: PublishOptions = {},
    ): Promise<number | null> {
        const builder = this.builderFor(aggregateType);
        const version = await this.recorder.bumpAggregateVersion(manager, aggregateType, parentId);
        assertExpectedAggregateVersion(aggregateType, parentId, version);
        const snapshot = await builder(manager, parentId);
        if (!snapshot) return null;
        await this.recorder.record(manager, {
            type,
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: aggregateType, id: parentId, version },
            data,
            changedFields: options.changedFields,
            previous: options.previous,
            actor: options.actor,
            visibility:
                options.visibility !== undefined
                    ? options.visibility
                    : snapshot.visibility !== undefined
                      ? snapshot.visibility
                      : ((snapshot.dto as { visibility?: string }).visibility ?? null),
        });
        return version;
    }

    /**
     * Claim the tombstone's version and snapshot an aggregate before it is
     * hard-deleted (call inside the delete's transaction).
     *
     * The version is bumped FIRST: the `UPDATE` takes the row lock, so an edit
     * racing the delete either committed before (and the snapshot includes it)
     * or waits and then finds the row gone — the tombstone can never reuse a
     * version a concurrent edit also recorded. Where the delete cannot share
     * this transaction (works, agents), the bump commits on its own; a delete
     * that then fails leaves only a gap in the versions, which consumers
     * tolerate.
     */
    async beforeDelete(
        manager: EntityManager,
        aggregateType: DomainEventAggregateType,
        id: string,
    ): Promise<AggregateTombstone | null> {
        const builder = this.builderFor(aggregateType);
        // An If-Match write that claimed its version first (a compare-and-set
        // on `version`, see `runWithClaimedAggregateVersion`) is not bumped twice.
        const claimed = takeClaimedAggregateVersion(aggregateType, id);
        const version =
            claimed ?? (await this.recorder.bumpAggregateVersion(manager, aggregateType, id));
        if (claimed === null) assertExpectedAggregateVersion(aggregateType, id, version);
        const snapshot = await builder(manager, id);
        return snapshot ? { aggregateType, id, snapshot } : null;
    }

    /** Record `<x>.deleted` with the snapshot `beforeDelete` took (its version) + `deleted: true`. */
    async deleted(
        manager: EntityManager,
        tombstone: AggregateTombstone | null,
        type: string,
        options: PublishOptions = {},
    ): Promise<void> {
        if (!tombstone) return;
        const dto = tombstone.snapshot.dto as { version?: number };
        await this.recorder.record(manager, {
            type,
            tenantId: tombstone.snapshot.tenantId,
            organizationId: tombstone.snapshot.organizationId,
            aggregate: {
                type: tombstone.aggregateType,
                id: tombstone.id,
                version: Number(dto.version) || 1,
            },
            data: { ...(tombstone.snapshot.dto as Record<string, unknown>), deleted: true },
            actor: options.actor,
            visibility: tombstone.snapshot.visibility,
        });
    }

    /**
     * `task.runtime_updated`: a machine-only write (PR/CI/run state). Bumps
     * neither `version` nor `updatedAt`; carries the current version.
     */
    async runtime(
        manager: EntityManager,
        taskId: string,
        options: PublishOptions = {},
    ): Promise<void> {
        const snapshot = await buildTaskSnapshot(manager, taskId);
        if (!snapshot) return;
        await this.recorder.record(manager, {
            type: 'task.runtime_updated',
            tenantId: snapshot.tenantId,
            organizationId: snapshot.organizationId,
            aggregate: { type: 'task', id: taskId, version: snapshot.dto.version },
            data: snapshot.dto as unknown as Record<string, unknown>,
            changedFields: options.changedFields ?? ['runtime'],
            previous: options.previous,
            actor: options.actor ?? { type: 'system', id: 'runtime', label: null },
        });
    }

    private builderFor(aggregateType: DomainEventAggregateType): Builder {
        const builder = BUILDERS[aggregateType];
        if (!builder) throw new Error(`No snapshot builder for aggregate type "${aggregateType}"`);
        return builder;
    }
}

/**
 * Record domain events in their own transaction AFTER a write that could not
 * join one (multi-step writes whose steps tolerate their own failures, or
 * services whose repositories take no `EntityManager` yet). Best-effort: a
 * failure is logged through `warn`, never thrown, so it can never fail the
 * write it describes. The integration's hourly reconcile repairs a missed
 * event. A no-op without a publisher.
 */
export async function recordAfterWrite(
    publisher: DomainEventPublisher | undefined,
    record: (publisher: DomainEventPublisher, manager: EntityManager) => Promise<unknown>,
    warn: (message: string) => void,
    label: string,
): Promise<void> {
    if (!publisher) return;
    try {
        await publisher.transaction((manager) => record(publisher, manager));
    } catch (err) {
        warn(`Could not record ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
