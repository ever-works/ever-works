import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
    AutonomyGrantScopeType,
    LadderedActionCategory,
    TrustRung,
} from '@ever-works/contracts';
import { AutonomyGrant } from '../entities/autonomy-grant.entity';

export interface AutonomyGrantScopeRef {
    scopeType: AutonomyGrantScopeType;
    scopeId: string;
}

export interface UpsertAutonomyGrantInput extends AutonomyGrantScopeRef {
    userId: string;
    category: LadderedActionCategory;
    rung: TrustRung;
    /** Who wrote it. Never absent — FR-31. */
    setByUserId: string;
    note?: string | null;
}

/**
 * Safety rails (AW-24) — feature-owned repository for the `autonomy_grants`
 * rows, provided by `SafetyModule` rather than `DatabaseModule` (the same
 * split as `ToolGrantRepository` and `MergePolicyScopeRepository`).
 *
 * Every method takes the owning `userId` and puts it in the WHERE clause.
 * That is not belt-and-braces: scope ids arrive from request bodies, and an
 * unscoped read here would turn the ladder into a cross-tenant oracle while
 * an unscoped write would let one workspace widen another's rungs.
 *
 * Scope-column stamping (`tenantId` / `organizationId`) is NOT done here:
 * `ScopeStampingSubscriber` fills both from the active `ScopeContextService`
 * on insert, and setting them by hand would fight its "explicit value wins"
 * rule.
 */
@Injectable()
export class AutonomyGrantRepository {
    constructor(
        @InjectRepository(AutonomyGrant)
        private readonly grants: Repository<AutonomyGrant>,
    ) {}

    /**
     * Every rung for one owner across a set of scopes, in a SINGLE query.
     *
     * The chain is at most twenty-four rows (twelve categories × two scopes),
     * but this sits on the tool loop's hot path behind a ten-second cache, and
     * an N+1 there would be an N+1 per tool call on a cache miss.
     */
    async findForScopes(
        userId: string,
        scopes: readonly AutonomyGrantScopeRef[],
    ): Promise<AutonomyGrant[]> {
        if (scopes.length === 0) return [];
        const rows = await this.grants.find({
            where: {
                userId,
                scopeType: In(scopes.map((scope) => scope.scopeType)),
                scopeId: In(scopes.map((scope) => scope.scopeId)),
            },
        });
        // `In × In` is a cross product, so a row for (workspace, agentId) —
        // impossible in practice but cheap to exclude — is filtered here
        // rather than trusted.
        const wanted = new Set(scopes.map((scope) => `${scope.scopeType}:${scope.scopeId}`));
        return rows.filter((row) => wanted.has(`${row.scopeType}:${row.scopeId}`));
    }

    /** One row, by its scope and category. `null` means inherit. */
    async findOne(
        userId: string,
        scope: AutonomyGrantScopeRef,
        category: LadderedActionCategory,
    ): Promise<AutonomyGrant | null> {
        return this.grants.findOne({
            where: {
                userId,
                scopeType: scope.scopeType,
                scopeId: scope.scopeId,
                category,
            },
        });
    }

    /** Write or replace the rung for one (owner, scope, category). */
    async upsert(input: UpsertAutonomyGrantInput): Promise<AutonomyGrant> {
        const existing = await this.findOne(
            input.userId,
            { scopeType: input.scopeType, scopeId: input.scopeId },
            input.category,
        );
        if (existing) {
            existing.rung = input.rung;
            existing.setByUserId = input.setByUserId;
            existing.note = input.note ?? null;
            return this.grants.save(existing);
        }
        return this.grants.save(
            this.grants.create({
                userId: input.userId,
                scopeType: input.scopeType,
                scopeId: input.scopeId,
                category: input.category,
                rung: input.rung,
                setByUserId: input.setByUserId,
                note: input.note ?? null,
            }),
        );
    }

    /**
     * Delete one row, reverting that (scope, category) to inherit.
     *
     * Owner-scoped, and answers whether anything was deleted so the caller can
     * 404 a foreign id rather than 403 it — a foreign identifier must read as
     * not found, never as forbidden.
     */
    async deleteById(userId: string, id: string): Promise<AutonomyGrant | null> {
        const row = await this.grants.findOne({ where: { id, userId } });
        if (!row) return null;
        await this.grants.delete({ id, userId });
        return row;
    }
}
