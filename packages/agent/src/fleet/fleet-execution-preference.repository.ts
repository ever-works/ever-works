import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { FleetExecutionMode, FleetExecutionScopeType } from '@ever-works/contracts';
import { FleetExecutionPreference } from '../entities/fleet-execution-preference.entity';

export interface UpsertFleetExecutionPreferenceData {
    userId: string;
    organizationId?: string | null;
    scopeType: FleetExecutionScopeType;
    scopeId?: string | null;
    mode: FleetExecutionMode;
}

/**
 * Feature-owned repository (provided by `FleetModule`, not
 * `DatabaseModule` — same split as `FleetNodeRepository`).
 */
@Injectable()
export class FleetExecutionPreferenceRepository {
    constructor(
        @InjectRepository(FleetExecutionPreference)
        private readonly repository: Repository<FleetExecutionPreference>,
    ) {}

    /** Every preference row of one owner, narrowest scopes first. */
    async findByUser(userId: string): Promise<FleetExecutionPreference[]> {
        return this.repository.find({
            where: { userId },
            order: { scopeType: 'ASC', createdAt: 'ASC' },
        });
    }

    async findOne(
        userId: string,
        scopeType: FleetExecutionScopeType,
        scopeId: string | null,
    ): Promise<FleetExecutionPreference | null> {
        return this.repository.findOne({
            // `IsNull()`, not `scopeId: null` — TypeORM renders a bare
            // null as `= NULL`, which matches nothing on either engine,
            // so the account-wide row would never be found and every
            // save would append a duplicate.
            where: { userId, scopeType, scopeId: scopeId === null ? IsNull() : scopeId },
        });
    }

    /**
     * One row per (owner, scope): find-then-save.
     *
     * This — not a database constraint — is where the invariant lives.
     * The account-wide row's `scopeId` is NULL, and neither Postgres nor
     * sqlite treats NULLs as equal in a UNIQUE index, so the index that
     * looks like it would enforce this would in fact enforce nothing for
     * exactly the row most likely to be written twice.
     */
    async upsert(data: UpsertFleetExecutionPreferenceData): Promise<FleetExecutionPreference> {
        const scopeId = data.scopeId ?? null;
        const existing = await this.findOne(data.userId, data.scopeType, scopeId);
        if (existing) {
            existing.mode = data.mode;
            if (data.organizationId !== undefined) {
                existing.organizationId = data.organizationId;
            }
            return this.repository.save(existing);
        }
        return this.repository.save(
            this.repository.create({
                userId: data.userId,
                organizationId: data.organizationId ?? null,
                scopeType: data.scopeType,
                scopeId,
                mode: data.mode,
            }),
        );
    }

    /** Remove one scope's row. Returns whether anything was deleted. */
    async remove(
        userId: string,
        scopeType: FleetExecutionScopeType,
        scopeId: string | null,
    ): Promise<boolean> {
        const result = await this.repository.delete({
            userId,
            scopeType,
            scopeId: scopeId === null ? IsNull() : scopeId,
        });
        return (result.affected ?? 0) > 0;
    }
}
