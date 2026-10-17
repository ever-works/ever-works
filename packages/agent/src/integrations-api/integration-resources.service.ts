import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type ObjectLiteral } from 'typeorm';
import {
    buildAgentSnapshot,
    buildGoalSnapshot,
    buildIdeaSnapshot,
    buildMemberSnapshot,
    buildMissionSnapshot,
    buildOrganizationSnapshot,
    buildTaskSnapshot,
    buildTeamSnapshot,
    buildWorkSnapshot,
    toTaskCommentDto,
    type AggregateSnapshot,
} from '../domain-events/domain-event-snapshots';
import { Agent } from '../entities/agent.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { TaskChatMessage } from '../entities/task-chat-message.entity';
import { Team } from '../entities/team.entity';
import { Work } from '../entities/work.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import type { ExternalLinkEntityType } from '../entities/external-record-link.entity';
import { ExternalRecordLinksService, type ExternalLinkDto } from './external-record-links.service';
import { etagFor } from './if-match';
import { ResourceNotFoundError } from './integration-api.errors';
import { type KeysetPage, type KeysetQuery, readKeysetPage } from './keyset-cursor';

/**
 * The versioned resources the integration API reads (contract v1 B.6): the P1
 * ones, then the P2 ones as they are served (ideas: EW-P2-1, goals: EW-P2-2,
 * missions: EW-P2-5).
 */
export type IntegrationResourceKind =
    | 'task'
    | 'team'
    | 'agent'
    | 'work'
    | 'idea'
    | 'goal'
    | 'mission';

type Row = ObjectLiteral & { id: string; updatedAt: Date; organizationId?: string | null };
type Builder = (manager: EntityManager, id: string) => Promise<AggregateSnapshot<object> | null>;

/**
 * How a kind hides its archived rows unless `includeArchived` (B.1): by
 * `status = 'archived'` (agents, works), by a set `archivedAt` (goals), or not
 * at all.
 */
type ArchiveRule = 'status' | 'archivedAt' | false;

const RESOURCES: Readonly<
    Record<
        IntegrationResourceKind,
        { entity: new () => Row; build: Builder; archivable: ArchiveRule }
    >
> = {
    task: { entity: Task as unknown as new () => Row, build: buildTaskSnapshot, archivable: false },
    team: { entity: Team as unknown as new () => Row, build: buildTeamSnapshot, archivable: false },
    agent: {
        entity: Agent as unknown as new () => Row,
        build: buildAgentSnapshot,
        archivable: 'status',
    },
    work: {
        entity: Work as unknown as new () => Row,
        build: buildWorkSnapshot,
        archivable: 'status',
    },
    // Ideas (`work_proposals`, EW-P2-1): a dismissed Idea is a status, not an archive.
    idea: {
        entity: WorkProposal as unknown as new () => Row,
        build: buildIdeaSnapshot,
        archivable: false,
    },
    // Goals (EW-P2-2): archived = `archivedAt` set (a view, never a deletion).
    goal: {
        entity: Goal as unknown as new () => Row,
        build: buildGoalSnapshot,
        archivable: 'archivedAt',
    },
    // Missions (EW-P2-5, plan D3b): completed / failed are statuses, not an archive.
    mission: {
        entity: Mission as unknown as new () => Row,
        build: buildMissionSnapshot,
        archivable: false,
    },
};

/**
 * Kinds whose rows STORE their visibility (EW-P1-3 columns). The snapshot DTO
 * may still report a derived value, so `private` is checked on the row.
 */
const STORED_VISIBILITY: ReadonlySet<IntegrationResourceKind> = new Set([
    'task',
    'agent',
    'idea',
    'goal',
    'mission',
]);

/** Chunk size for `IN (...)` lookups. */
const ID_CHUNK = 500;

/** A list query: keyset paging plus `includeArchived` (agents and works; default false). */
export interface IntegrationListQuery extends KeysetQuery {
    readonly includeArchived?: boolean;
}

/** A resource DTO with the caller's `externalLinks`, plus its `ETag`. */
export interface IntegrationResource {
    readonly dto: Record<string, unknown>;
    readonly etag: string | null;
}

/**
 * Reads of `/api/integrations/v1` resources (EW-P1-4, contract v1 B.6).
 *
 * The DTOs are exactly the domain-event `data` snapshots (the same builders),
 * so a resource read and an event of the same version are byte-equivalent,
 * plus `externalLinks` filtered to the caller's source.
 *
 * Visibility (contract v1 §1.3): the integration principal sees `team` and
 * `organization` rows of its pinned organization; a `private` row is never
 * served — it is left out of lists and answers `404 not_found` by id.
 */
@Injectable()
export class IntegrationResourcesService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly links: ExternalRecordLinksService,
    ) {}

    async list(
        kind: IntegrationResourceKind,
        organizationId: string,
        query: IntegrationListQuery,
        source: string,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        const { entity, build, archivable } = RESOURCES[kind];
        const qb = this.dataSource
            .getRepository(entity)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        if (archivable === 'status' && !query.includeArchived) {
            qb.andWhere('row.status != :archived', { archived: 'archived' });
        } else if (archivable === 'archivedAt' && !query.includeArchived) {
            qb.andWhere('row.archivedAt IS NULL');
        }
        if (STORED_VISIBILITY.has(kind)) {
            qb.andWhere('row.visibility != :private', { private: 'private' });
        }
        const page = await readKeysetPage(qb, 'row', query);
        const manager = this.dataSource.manager;
        const dtos: Record<string, unknown>[] = [];
        for (const row of page.data) {
            const snapshot = await build(manager, row.id);
            if (!snapshot || isPrivate(snapshot.dto)) continue;
            dtos.push(snapshot.dto as Record<string, unknown>);
        }
        return {
            data: await this.withLinks(kind, organizationId, dtos, source),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    async get(
        kind: IntegrationResourceKind,
        organizationId: string,
        id: string,
        source: string,
    ): Promise<IntegrationResource> {
        if (STORED_VISIBILITY.has(kind) && (await this.isStoredPrivate(kind, id))) {
            throw notFound(kind, id);
        }
        const snapshot = await RESOURCES[kind].build(this.dataSource.manager, id);
        if (!snapshot || snapshot.organizationId !== organizationId || isPrivate(snapshot.dto)) {
            throw notFound(kind, id);
        }
        const [dto] = await this.withLinks(
            kind,
            organizationId,
            [snapshot.dto as Record<string, unknown>],
            source,
        );
        const version = Number((snapshot.dto as { version?: unknown }).version);
        return { dto, etag: Number.isFinite(version) ? etagFor(version) : null };
    }

    /** `GET /organization` — the pinned organization. */
    async organization(organizationId: string): Promise<IntegrationResource> {
        const snapshot = await buildOrganizationSnapshot(this.dataSource.manager, organizationId);
        if (!snapshot) throw notFound('organization', organizationId);
        const version = Number((snapshot.dto as { version?: unknown }).version);
        return {
            dto: snapshot.dto as unknown as Record<string, unknown>,
            etag: Number.isFinite(version) ? etagFor(version) : null,
        };
    }

    /** `GET /members` — the organization's roster, ordered by `(updatedAt, id)`. */
    async members(
        organizationId: string,
        query: KeysetQuery,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        const qb = this.dataSource
            .getRepository(OrganizationMember)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        const page = await readKeysetPage(qb, 'row', query);
        const data: Record<string, unknown>[] = [];
        for (const row of page.data) {
            const member = await buildMemberSnapshot(this.dataSource.manager, row);
            if (member) data.push(member as unknown as Record<string, unknown>);
        }
        return { data, nextCursor: page.nextCursor, hasMore: page.hasMore };
    }

    /**
     * `GET /tasks/:id/comments` — the task's comments, ordered by
     * `(updatedAt, id)` (an edit moves a comment behind the cursor, so an
     * `updatedSince` sync picks it up). The task must be one the caller sees.
     */
    async comments(
        organizationId: string,
        taskId: string,
        query: KeysetQuery,
        source: string,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        await this.get('task', organizationId, taskId, source);
        const qb = this.dataSource
            .getRepository(TaskChatMessage)
            .createQueryBuilder('row')
            .where('row.taskId = :taskId', { taskId });
        const page = await readKeysetPage(qb, 'row', query);
        const dtos = page.data.map(
            (row) => toTaskCommentDto(row, organizationId) as unknown as Record<string, unknown>,
        );
        return {
            data: await this.withLinks('task_comment', organizationId, dtos, source),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    /** One comment of a task the caller sees (`404` otherwise). */
    async comment(
        organizationId: string,
        taskId: string,
        commentId: string,
        source: string,
    ): Promise<Record<string, unknown>> {
        await this.get('task', organizationId, taskId, source);
        const row = await this.dataSource
            .getRepository(TaskChatMessage)
            .findOne({ where: { id: commentId, taskId } });
        if (!row) throw notFound('task_comment', commentId);
        const [dto] = await this.withLinks(
            'task_comment',
            organizationId,
            [toTaskCommentDto(row, organizationId) as unknown as Record<string, unknown>],
            source,
        );
        return dto;
    }

    /**
     * `PUT /links/:entityType/:entityId` — the record must be one the caller
     * sees in the organization (`404 not_found` otherwise). Answers `false` for
     * an entity type v1 does not serve yet (inbox, KB: P3),
     * which the route refuses as `validation_failed`.
     */
    async assertLinkTarget(
        entityType: ExternalLinkEntityType,
        organizationId: string,
        entityId: string,
        source: string,
    ): Promise<boolean> {
        switch (entityType) {
            case 'task':
            case 'team':
            case 'agent':
            case 'work':
            case 'idea':
            case 'goal':
            case 'mission':
                await this.get(entityType, organizationId, entityId, source);
                return true;
            case 'member': {
                const member = await this.dataSource
                    .getRepository(OrganizationMember)
                    .findOne({ where: { organizationId, userId: entityId } });
                if (!member) throw notFound('member', entityId);
                return true;
            }
            case 'task_comment': {
                const comment = await this.dataSource
                    .getRepository(TaskChatMessage)
                    .findOne({ where: { id: entityId }, select: ['id', 'taskId'] });
                if (!comment) throw notFound('task_comment', entityId);
                await this.get('task', organizationId, comment.taskId, source).catch(() => {
                    throw notFound('task_comment', entityId);
                });
                return true;
            }
            default:
                return false;
        }
    }

    /**
     * `GET /links`: drop the links whose record is `private` (a task or agent
     * made private, or a comment on a private task) — a link would otherwise
     * still reveal the record's id and its external id and URL.
     */
    async withoutPrivateTargets<T extends { entityType: string; entityId: string }>(
        rows: T[],
    ): Promise<T[]> {
        const hidden = new Set<string>();
        for (const kind of STORED_VISIBILITY) {
            const ids = rows.filter((row) => row.entityType === kind).map((row) => row.entityId);
            for (const chunk of chunks(ids)) {
                const found = (await this.dataSource
                    .getRepository(RESOURCES[kind].entity)
                    .createQueryBuilder('row')
                    .select('row.id', 'id')
                    .where('row.id IN (:...ids)', { ids: chunk })
                    .andWhere('row.visibility = :private', { private: 'private' })
                    .getRawMany()) as Array<{ id: string }>;
                for (const { id } of found) hidden.add(`${kind}:${id}`);
            }
        }
        const commentIds = rows
            .filter((row) => row.entityType === 'task_comment')
            .map((row) => row.entityId);
        for (const chunk of chunks(commentIds)) {
            const found = (await this.dataSource
                .getRepository(TaskChatMessage)
                .createQueryBuilder('comment')
                .innerJoin(Task, 'task', 'task.id = comment.taskId')
                .select('comment.id', 'id')
                .where('comment.id IN (:...ids)', { ids: chunk })
                .andWhere('task.visibility = :private', { private: 'private' })
                .getRawMany()) as Array<{ id: string }>;
            for (const { id } of found) hidden.add(`task_comment:${id}`);
        }
        return rows.filter((row) => !hidden.has(`${row.entityType}:${row.entityId}`));
    }

    private async isStoredPrivate(kind: IntegrationResourceKind, id: string): Promise<boolean> {
        const row = (await this.dataSource
            .getRepository(RESOURCES[kind].entity)
            .createQueryBuilder('row')
            .select('row.visibility', 'visibility')
            .where('row.id = :id', { id })
            .getRawOne()) as { visibility?: string } | undefined;
        return row?.visibility === 'private';
    }

    private async withLinks(
        kind: ExternalLinkEntityType,
        organizationId: string,
        dtos: Record<string, unknown>[],
        source: string,
    ): Promise<Record<string, unknown>[]> {
        const ids = dtos.map((dto) => String(dto.id));
        const byEntity = await this.links.linksFor(organizationId, kind, ids, source);
        return dtos.map((dto) => ({
            ...dto,
            externalLinks: byEntity.get(String(dto.id)) ?? ([] as ExternalLinkDto[]),
        }));
    }
}

function isPrivate(dto: object): boolean {
    return (dto as { visibility?: unknown }).visibility === 'private';
}

function notFound(kind: string, id: string): ResourceNotFoundError {
    return new ResourceNotFoundError(kind, id);
}

function chunks<T>(items: T[]): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += ID_CHUNK) {
        out.push(items.slice(index, index + ID_CHUNK));
    }
    return out;
}
