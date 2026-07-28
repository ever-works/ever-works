import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { ToolGrantOverride, ToolGrantScope } from '@ever-works/contracts';
import { ToolGrant } from '../entities/tool-grant.entity';

/** One (scope, id) pair to load a grant row for. */
export interface ToolGrantScopeRef {
    scopeType: ToolGrantScope;
    scopeId: string;
}

export interface UpsertToolGrantInput extends ToolGrantScopeRef {
    userId: string;
    grant: ToolGrantOverride;
    note?: string | null;
}

/**
 * Tool-grant matrix (audit item G4) — feature-owned repository for the
 * `tool_grants` rows.
 *
 * Provided by `PolicyModule`, not `DatabaseModule` — the same split as
 * `MergePolicyScopeRepository` / `FleetNodeRepository` / `MeetingRepository`.
 *
 * Every method takes the owning `userId` and puts it in the WHERE clause.
 * That is not belt-and-braces: the scope ids arrive from request bodies
 * and, on the chat-tool path, from the MODEL — an unscoped read here would
 * turn the matrix into a cross-tenant oracle, and an unscoped write would
 * let one tenant grant itself tools inside another.
 *
 * Scope-column stamping (`tenantId` / `organizationId`) is NOT done here:
 * `ScopeStampingSubscriber` fills both from the active `ScopeContextService`
 * on insert. Setting them manually would fight the subscriber's
 * "explicit value wins" rule.
 */
@Injectable()
export class ToolGrantRepository {
    constructor(
        @InjectRepository(ToolGrant)
        private readonly grants: Repository<ToolGrant>,
    ) {}

    /**
     * Load every grant row for one owner across a set of scope refs, in a
     * SINGLE query (the chain is at most four rows, but N+1 on the tool
     * loop's hot path is still N+1).
     */
    async findForScopes(userId: string, refs: ToolGrantScopeRef[]): Promise<ToolGrant[]> {
        if (refs.length === 0) return [];
        const scopeTypes = Array.from(new Set(refs.map((r) => r.scopeType)));
        const scopeIds = Array.from(new Set(refs.map((r) => r.scopeId)));
        const rows = await this.grants.find({
            where: { userId, scopeType: In(scopeTypes), scopeId: In(scopeIds) },
        });
        // The IN × IN product can match a (type, id) pair nobody asked for
        // when two scopes share an id — filter back down to the exact refs.
        const wanted = new Set(refs.map((r) => `${r.scopeType}:${r.scopeId}`));
        return rows.filter((row) => wanted.has(`${row.scopeType}:${row.scopeId}`));
    }

    async findOne(userId: string, ref: ToolGrantScopeRef): Promise<ToolGrant | null> {
        return this.grants.findOne({
            where: { userId, scopeType: ref.scopeType, scopeId: ref.scopeId },
        });
    }

    async findByIdAndUser(id: string, userId: string): Promise<ToolGrant | null> {
        return this.grants.findOne({ where: { id, userId } });
    }

    async listForUser(userId: string): Promise<ToolGrant[]> {
        return this.grants.find({ where: { userId }, order: { createdAt: 'ASC' } });
    }

    /**
     * Create-or-update the single row for (userId, scopeType, scopeId).
     * The unique index makes that tuple the natural key, so a second write
     * for the same scope is an UPDATE — never a second, contradictory
     * layer in the chain.
     */
    async upsert(input: UpsertToolGrantInput): Promise<ToolGrant> {
        const existing = await this.findOne(input.userId, input);
        const allow = input.grant.allow ?? null;
        const deny = input.grant.deny ?? null;
        if (existing) {
            await this.grants.update(
                { id: existing.id, userId: input.userId },
                { allow, deny, note: input.note ?? null },
            );
            const refreshed = await this.findByIdAndUser(existing.id, input.userId);
            return refreshed ?? existing;
        }
        const created = this.grants.create({
            userId: input.userId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            allow,
            deny,
            note: input.note ?? null,
        });
        return this.grants.save(created);
    }

    async deleteByIdAndUser(id: string, userId: string): Promise<boolean> {
        const result = await this.grants.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }
}
