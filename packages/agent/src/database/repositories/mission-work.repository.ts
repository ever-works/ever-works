import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MissionWork, type MissionWorkRelation } from '../../entities/mission-work.entity';
import { ownershipWhere, type OwnershipScope } from '../ownership-scope';

/** A mission_works row hydrated with the Work's display fields. */
export interface MissionWorkWithWork {
    id: string;
    tenantId: string | null;
    organizationId: string | null;
    missionId: string;
    workId: string;
    relation: MissionWorkRelation;
    createdAt: Date;
    workName: string | null;
    workSlug: string | null;
}

/** A mission_works row hydrated with the Mission's display fields
 *  (reverse lookup — "which Missions relate to this Work"). */
export interface MissionWorkWithMission {
    id: string;
    tenantId: string | null;
    organizationId: string | null;
    missionId: string;
    workId: string;
    relation: MissionWorkRelation;
    createdAt: Date;
    missionTitle: string | null;
    missionStatus: string | null;
}

/**
 * Repository for `mission_works` — the explicit Mission↔Work M:N edge
 * (domain-model review §8.1). Rows are cheap references, not ownership:
 * they CASCADE away with either endpoint and are freely attachable /
 * detachable by the owner (except nothing here ever deletes a Work —
 * invariant I-6/I-7).
 */
@Injectable()
export class MissionWorkRepository {
    constructor(
        @InjectRepository(MissionWork)
        private readonly repository: Repository<MissionWork>,
    ) {}

    /** Idempotent attach — duplicate (mission, work, relation) is a no-op. */
    async attach(input: {
        missionId: string;
        workId: string;
        userId: string;
        relation: MissionWorkRelation;
    }): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .insert()
            .into(MissionWork)
            .values({
                missionId: input.missionId,
                workId: input.workId,
                userId: input.userId,
                relation: input.relation,
            })
            .orIgnore()
            .execute();
    }

    /** Owner-scoped detach; returns true iff a row was removed. */
    async detach(input: {
        missionId: string;
        workId: string;
        userId: string;
        relation: MissionWorkRelation;
        scope?: OwnershipScope;
    }): Promise<boolean> {
        if (input.scope) {
            const query = this.repository
                .createQueryBuilder('rel')
                .delete()
                .from(MissionWork)
                .where(
                    'missionId = :missionId AND workId = :workId AND userId = :userId AND relation = :relation',
                    input,
                );
            this.applyOwnershipScope(query, ['mission_works'], input.scope, false);
            const res = await query.execute();
            return (res.affected ?? 0) > 0;
        }
        const res = await this.repository.delete({
            missionId: input.missionId,
            workId: input.workId,
            userId: input.userId,
            relation: input.relation,
        });
        return (res.affected ?? 0) > 0;
    }

    /** Relations for one Mission (owner-scoped), newest first, with Work display fields. */
    async listForMissionWithWork(
        missionId: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<MissionWorkWithWork[]> {
        const query = this.repository
            .createQueryBuilder('rel')
            .leftJoin('rel.work', 'work')
            .select([
                'rel.id AS "id"',
                'rel.tenantId AS "tenantId"',
                'rel.organizationId AS "organizationId"',
                'rel.missionId AS "missionId"',
                'rel.workId AS "workId"',
                'rel.relation AS "relation"',
                'rel.createdAt AS "createdAt"',
                'work.name AS "workName"',
                'work.slug AS "workSlug"',
            ])
            .where('rel.missionId = :missionId AND rel.userId = :userId', { missionId, userId })
            .orderBy('rel.createdAt', 'DESC');
        this.applyOwnershipScope(query, ['rel', 'work'], scope);
        return query.getRawMany<MissionWorkWithWork>();
    }

    /** Reverse — relations touching one Work (owner-scoped), with Mission display fields. */
    async listForWorkWithMission(
        workId: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<MissionWorkWithMission[]> {
        const query = this.repository
            .createQueryBuilder('rel')
            .leftJoin('rel.mission', 'mission')
            .select([
                'rel.id AS "id"',
                'rel.tenantId AS "tenantId"',
                'rel.organizationId AS "organizationId"',
                'rel.missionId AS "missionId"',
                'rel.workId AS "workId"',
                'rel.relation AS "relation"',
                'rel.createdAt AS "createdAt"',
                'mission.title AS "missionTitle"',
                'mission.status AS "missionStatus"',
            ])
            .where('rel.workId = :workId AND rel.userId = :userId', { workId, userId })
            .orderBy('rel.createdAt', 'DESC');
        this.applyOwnershipScope(query, ['rel', 'mission'], scope);
        return query.getRawMany<MissionWorkWithMission>();
    }

    /** Mission ids related to a Work (for the list endpoint's workId filter). */
    async missionIdsForWork(
        workId: string,
        userId: string,
        scope?: OwnershipScope,
    ): Promise<string[]> {
        const rows = await this.repository.find({
            where: scope
                ? ownershipWhere<MissionWork>(userId, scope).map((branch) => ({
                      ...branch,
                      workId,
                  }))
                : { workId, userId },
            select: { missionId: true },
        });
        return [...new Set(rows.map((r) => r.missionId))];
    }

    private applyOwnershipScope(
        query: { andWhere(predicate: string, parameters?: Record<string, unknown>): unknown },
        aliases: string[],
        scope?: OwnershipScope,
        qualified = true,
    ): void {
        if (!scope) return;
        const column = (alias: string, name: string) => (qualified ? `${alias}.${name}` : name);
        for (const alias of aliases) {
            if (scope.organizationId) {
                query.andWhere(
                    `${column(alias, 'tenantId')} = :scopeTenantId AND ${column(alias, 'organizationId')} = :scopeOrganizationId`,
                    {
                        scopeTenantId: scope.tenantId,
                        scopeOrganizationId: scope.organizationId,
                    },
                );
            } else {
                query.andWhere(`${column(alias, 'organizationId')} IS NULL`);
                if (scope.tenantId) {
                    query.andWhere(
                        `(${column(alias, 'tenantId')} = :scopeTenantId OR ${column(alias, 'tenantId')} IS NULL)`,
                        { scopeTenantId: scope.tenantId },
                    );
                } else {
                    query.andWhere(`${column(alias, 'tenantId')} IS NULL`);
                }
            }
        }
    }
}
