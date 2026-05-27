import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import type { Organization } from '@ever-works/agent/entities';
import { UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS } from '@ever-works/contracts/api';
import { UsernameAllocatorService } from '../users/services/username-allocator.service';
import { TenantBootstrapService } from '../scope/tenant-bootstrap.service';

/**
 * Tables with both a direct user-FK column AND a `tenantId` column —
 * the universe `createOrganization`'s unconditional backfill walks to
 * stamp `tenantId` on the user's existing rows after lazy-creating
 * the Tenant.
 *
 * Per-table user-column name because the codebase didn't use a single
 * convention before Phase 6: most tables use `userId`, but `templates`
 * uses `ownerUserId`. Tables that have no direct user FK at all
 * (`work_deployments`, `onboarding_requests`, `webhook_subscriptions`,
 * `github_app_installations`, `work_knowledge_documents`,
 * `verification`) are intentionally absent — those rows are owned
 * transitively through a parent and will be backfilled via a join in
 * the Phase 6b follow-up. (Codex P1 on PR #1058 caught the bug where
 * `templates` was included with `userId` despite its column being
 * `ownerUserId`.)
 *
 * Tier C tables are NOT included here either: they reference their
 * Tier A parent via FK and the "join through parent" SQL is hairy
 * enough to defer to Phase 6b. New Tier C inserts after Phase 7
 * lands get the right scope via
 * [ScopeStampingSubscriber](../scope/scope-stamping.subscriber.ts).
 */
interface UserOwnedTable {
    table: string;
    userColumn: string;
}

const TIER_A_BACKFILL_TABLES: ReadonlyArray<UserOwnedTable> = [
    { table: 'missions', userColumn: 'userId' },
    { table: 'work_proposals', userColumn: 'userId' },
    { table: 'tasks', userColumn: 'userId' },
    { table: 'agents', userColumn: 'userId' },
    { table: 'skills', userColumn: 'userId' },
    { table: 'conversations', userColumn: 'userId' },
    { table: 'notifications', userColumn: 'userId' },
    { table: 'api_keys', userColumn: 'userId' },
    { table: 'templates', userColumn: 'ownerUserId' },
    { table: 'template_customizations', userColumn: 'userId' },
    { table: 'user_subscriptions', userColumn: 'userId' },
    { table: 'work_schedules', userColumn: 'userId' },
    { table: 'github_app_user_links', userColumn: 'userId' },
    { table: 'works', userColumn: 'userId' },
] as const;

const TIER_B_BACKFILL_TABLES: ReadonlyArray<UserOwnedTable> = [
    { table: 'account', userColumn: 'userId' },
    { table: 'session', userColumn: 'userId' },
    { table: 'refresh_tokens', userColumn: 'userId' },
    { table: 'user_template_preferences', userColumn: 'userId' },
    { table: 'user_task_counter', userColumn: 'userId' },
] as const;

/**
 * EW-658 (Tenants & Organizations Phase 6) — Organization CRUD +
 * lazy-upgrade flow.
 *
 * See [spec.md §5.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization)
 * and [plan.md Phase 6](../../../../docs/specs/features/tenants-and-organizations/plan.md#phase-6--lazy-upgrade-flow--organization-create-api)
 * for the design.
 *
 * **State machine for a fresh user:**
 *
 *   1. User signs up — `users.tenantId IS NULL`, no Organizations.
 *   2. User creates a Mission, an Idea, etc. — those rows land with
 *      `tenantId = NULL`, `organizationId = NULL`. ([ScopeStampingSubscriber](../scope/scope-stamping.subscriber.ts)
 *      is no-op here because there's no Tenant to stamp from.)
 *   3. User clicks "Create Organization" → `createOrganization(...)`:
 *      a. `TenantBootstrapService.ensureTenant` lazy-creates the
 *         Tenant if needed.
 *      b. Allocate the Org slug via `UsernameAllocatorService`
 *         (collides against `users.slug` + `organizations.slug`).
 *      c. INSERT the Organization row.
 *      d. Set `users.lastScopeOrganizationId` so the next login lands
 *         on the new Org's scope.
 *      e. **Unconditional `tenantId` backfill**: walk every
 *         user-owned table and UPDATE rows with `tenantId IS NULL` →
 *         `tenantId = newTenant.id`. (Tier A + Tier B from the
 *         `TENANT_BACKFILL_TABLES` constant above.)
 *   4. From this point on, the user has one Org. Two paths:
 *      a. **Upgrade**: `upgradeFromAccount(userId, orgId)` —
 *         additionally sets `organizationId = orgId` on all of the
 *         user's Tier A rows that have `organizationId` (the same
 *         table list minus Tier B). Idempotent on the same first Org;
 *         returns 409 if called after the user has > 1 Org.
 *      b. **Empty**: user does nothing; existing rows stay
 *         `tenantId = newTenant.id, organizationId = NULL` (i.e.
 *         visible from the bare-Tenant scope only). The new Org
 *         starts empty. Both behaviors are valid; [spec.md §5.2
 *         3a/3b](../../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization).
 *
 * **Out of scope this phase (Phase 6b follow-up):** Tier C
 * `organizationId` backfill via parent-FK join. Today new Tier C
 * inserts get the right scope from the subscriber; only the
 * historical pre-Phase-6 Tier C rows aren't moved.
 */
@Injectable()
export class OrganizationService {
    private readonly logger = new Logger(OrganizationService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly userRepository: UserRepository,
        private readonly organizationRepository: OrganizationRepository,
        private readonly tenantBootstrap: TenantBootstrapService,
        private readonly usernameAllocator: UsernameAllocatorService,
    ) {}

    /**
     * Create an Organization for the given user. Lazy-creates the
     * Tenant if needed. Returns the new Org row.
     *
     * Wraps the slug allocation + Tenant create + Org insert + user
     * backfill in a single transaction so a mid-flow failure leaves
     * the DB in a coherent state. The Tenant lazy-create can run
     * outside the txn because it's idempotent (the
     * `tenants.ownerUserId UNIQUE` constraint catches racers), but
     * the rest must be atomic.
     */
    async createOrganization(
        userId: string,
        name: string,
        slugOverride?: string,
    ): Promise<Organization> {
        const trimmedName = name?.trim();
        if (!trimmedName) {
            throw new ConflictException('Organization name is required');
        }
        if (trimmedName.length > 200) {
            throw new ConflictException('Organization name exceeds 200 characters');
        }

        const tenant = await this.tenantBootstrap.ensureTenant(userId);

        const slugBase = slugOverride?.trim() || trimmedName;
        const slug = await this.usernameAllocator.allocateUsername(slugBase);

        return this.dataSource.transaction(async (manager) => {
            // Use the manager's repository so the INSERT lands in the
            // same transaction as the backfill UPDATEs below.
            const org = manager.getRepository<Organization>('organizations').create({
                tenantId: tenant.id,
                slug,
                displayName: trimmedName,
            });
            const saved = await manager.getRepository<Organization>('organizations').save(org);

            // Step (d): pin the new Org as the user's last-seen scope
            // so the next login lands on it. Only do this if the user
            // hasn't already explicitly picked another Org as their
            // landing scope (defensive — shouldn't be possible on first
            // Org, but cheap to check).
            const currentUser = await manager
                .getRepository('users')
                .findOne({ where: { id: userId } });
            if (currentUser && currentUser.lastScopeOrganizationId === null) {
                await manager
                    .getRepository('users')
                    .update(userId, { lastScopeOrganizationId: saved.id });
            }

            // Step (e): unconditional tenantId backfill. Walks every
            // user-owned table and stamps `tenantId = tenant.id` on
            // rows where it's still NULL. Idempotent — re-running this
            // is a no-op once all rows have tenantId set.
            const allTables = [...TIER_A_BACKFILL_TABLES, ...TIER_B_BACKFILL_TABLES];
            for (const { table, userColumn } of allTables) {
                await manager.query(
                    `UPDATE "${table}" SET "tenantId" = $1 WHERE "${userColumn}" = $2 AND "tenantId" IS NULL`,
                    [tenant.id, userId],
                );
            }

            this.logger.log(
                `Created Organization ${saved.id} (slug=${saved.slug}) for user ${userId}; tenantId backfilled across ${allTables.length} tables`,
            );

            return saved;
        });
    }

    /**
     * "Upgrade" the user's existing bare-Tenant data into this
     * Organization. Sets `organizationId = orgId` on every Tier A row
     * the user owns where it was previously NULL.
     *
     * Gated by the **first-Org guard** ([spec.md §5.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization)):
     * only callable while the user has EXACTLY ONE Organization under
     * their Tenant, AND that Org is `:organizationId`. Either condition
     * failing → 409 Conflict with code
     * `UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS`. This prevents the
     * user from retroactively pulling all their items into a later
     * Org once they've created multiple.
     *
     * Idempotent on the same first Org: re-running this returns the
     * same counts (zero on the second call, because all rows have
     * tenantId set by then so the `tenantId IS NULL` filter excludes
     * them).
     *
     * **Out of scope (Phase 6b follow-up):** Tier C
     * `organizationId` backfill. New Tier C inserts get the right
     * scope from the auto-stamping subscriber once Phase 7's slug
     * middleware populates ScopeContext; only the historical
     * pre-Phase-6 Tier C rows aren't moved.
     */
    async upgradeFromAccount(
        userId: string,
        organizationId: string,
    ): Promise<{
        tierARowsUpdated: number;
        tierBRowsUpdated: number;
        organizationId: string;
        tenantId: string;
    }> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }
        if (!user.tenantId) {
            // Can only upgrade if a Tenant exists. If it doesn't, the
            // user hasn't created an Organization yet — the controller
            // should have routed them to POST /api/organizations first.
            throw new ConflictException(
                'User has no Tenant — create an Organization first via POST /api/organizations',
            );
        }

        const org = await this.organizationRepository.findById(organizationId);
        if (!org) {
            throw new NotFoundException(`Organization ${organizationId} not found`);
        }
        if (org.tenantId !== user.tenantId) {
            // Don't leak existence: same response as missing.
            throw new NotFoundException(`Organization ${organizationId} not found`);
        }

        // First-Org guard: SELECT COUNT(*) FROM organizations WHERE
        // tenantId = user.tenantId must equal 1, and the single row's
        // id must equal organizationId. (Combined into one query for
        // race safety — see [spec.md §5.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization).)
        const orgCount = await this.organizationRepository.countByTenantId(user.tenantId);
        if (orgCount !== 1) {
            throw new ConflictException({
                code: UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS,
                message: 'Upgrade is only available before creating a second Organization',
            });
        }

        const tenantId = user.tenantId;
        const newOrgId = org.id;

        return this.dataSource.transaction(async (manager) => {
            // Postgres: cap the transaction so a runaway backfill
            // doesn't hold locks indefinitely on prod traffic. SQLite
            // doesn't recognize this; wrap in a try so the call is a
            // no-op there. (Local test/CLI contexts use SQLite.)
            try {
                await manager.query(`SET LOCAL statement_timeout = '30s'`);
            } catch {
                // Non-Postgres adapter — ignore.
            }

            // Tier A: stamp BOTH tenantId AND organizationId on rows
            // owned by this user that haven't been pulled into an Org
            // yet. The WHERE filter is `organizationId IS NULL` (NOT
            // `tenantId IS NULL`) because by the time the user hits
            // upgrade-from-account, `createOrganization` has already
            // backfilled tenantId on every row — so a `tenantId IS NULL`
            // filter would find nothing. We still SET `tenantId` as a
            // belt-and-suspenders write: if a caller drove this endpoint
            // without going through createOrganization first (e.g.
            // direct DB tool), the Tenant FK is still enforced.
            // (Codex P1 on PR #1058 caught this.)
            let tierARowsUpdated = 0;
            for (const { table, userColumn } of TIER_A_BACKFILL_TABLES) {
                const result = (await manager.query(
                    `UPDATE "${table}" SET "tenantId" = $1, "organizationId" = $2 WHERE "${userColumn}" = $3 AND "organizationId" IS NULL`,
                    [tenantId, newOrgId, userId],
                )) as [unknown[], number] | { affected?: number } | undefined;
                tierARowsUpdated += this.extractAffectedRowCount(result);
            }

            // Tier B: no `organizationId` column. The only thing left
            // to stamp is `tenantId`, which `createOrganization` has
            // already done — so this loop is purely defensive. Same
            // `tenantId IS NULL` filter as before because Tier B has
            // no other way to express "not-yet-stamped".
            let tierBRowsUpdated = 0;
            for (const { table, userColumn } of TIER_B_BACKFILL_TABLES) {
                const result = (await manager.query(
                    `UPDATE "${table}" SET "tenantId" = $1 WHERE "${userColumn}" = $2 AND "tenantId" IS NULL`,
                    [tenantId, userId],
                )) as [unknown[], number] | { affected?: number } | undefined;
                tierBRowsUpdated += this.extractAffectedRowCount(result);
            }

            this.logger.log(
                `Upgrade-from-account: user=${userId} org=${newOrgId} tierA=${tierARowsUpdated} tierB=${tierBRowsUpdated}`,
            );

            return {
                tierARowsUpdated,
                tierBRowsUpdated,
                organizationId: newOrgId,
                tenantId,
            };
        });
    }

    /**
     * Public read-by-id for callers that already have an `id`. The
     * controller layer uses this for the upgrade-from-account response
     * payload after the txn commits.
     */
    async findById(id: string): Promise<Organization | null> {
        return this.organizationRepository.findById(id);
    }

    /**
     * List all Organizations for the current user's Tenant. Returns
     * `[]` if the user has no Tenant yet (no Orgs possible).
     */
    async listForUser(userId: string): Promise<Organization[]> {
        const user = await this.userRepository.findById(userId);
        if (!user || !user.tenantId) {
            return [];
        }
        return this.organizationRepository.findByTenantId(user.tenantId);
    }

    /**
     * Fetch one Organization by slug. Used by the slug-resolver
     * middleware (Phase 7) and the GET /api/organizations/:slug route.
     */
    async findBySlug(slug: string): Promise<Organization | null> {
        return this.organizationRepository.findBySlug(slug);
    }

    /**
     * Update display/legal/country fields on an Organization. Verifies
     * the caller owns the Tenant.
     */
    async update(
        userId: string,
        organizationId: string,
        patch: { displayName?: string; legalName?: string; countryCode?: string },
    ): Promise<Organization> {
        const user = await this.userRepository.findById(userId);
        if (!user || !user.tenantId) {
            throw new UnauthorizedException('User has no Tenant');
        }
        const org = await this.organizationRepository.findById(organizationId);
        if (!org || org.tenantId !== user.tenantId) {
            throw new NotFoundException(`Organization ${organizationId} not found`);
        }
        await this.organizationRepository.update(organizationId, patch);
        const updated = await this.organizationRepository.findById(organizationId);
        if (!updated) {
            // Race with a concurrent delete — surface as NotFound.
            throw new NotFoundException(`Organization ${organizationId} not found`);
        }
        return updated;
    }

    /**
     * Slug-availability check. Returns `{ available, normalized, suggestion? }`.
     * Delegates to the shared allocator which checks BOTH
     * `users.slug` AND `organizations.slug`.
     */
    async checkSlugAvailability(
        desired: string,
    ): Promise<{ available: boolean; normalized: string; suggestion?: string }> {
        return this.usernameAllocator.suggest(desired);
    }

    /**
     * Read the typeorm `query()` result's affected-row count across
     * adapters. Postgres returns `[rows, count]`; some adapters return
     * `{ affected }`; others return `undefined`. Treat unknown shape as
     * 0 rather than crashing.
     */
    private extractAffectedRowCount(
        result: [unknown[], number] | { affected?: number } | undefined,
    ): number {
        if (Array.isArray(result) && result.length >= 2 && typeof result[1] === 'number') {
            return result[1];
        }
        if (result && typeof result === 'object' && 'affected' in result) {
            return result.affected ?? 0;
        }
        return 0;
    }
}
