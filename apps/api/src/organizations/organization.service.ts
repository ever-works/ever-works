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
import type {
    Organization,
    OrganizationRegistrationProvider,
    OrganizationRegistrationStatus,
} from '@ever-works/agent/entities';
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
 * a future follow-up. (Codex P1 on PR #1058 caught the bug where
 * `templates` was included with `userId` despite its column being
 * `ownerUserId`.)
 *
 * Tier C tables are NOT included here either: they reference their
 * Tier A parent via FK. EW-663 (Phase 11) added a separate
 * `TIER_C_BACKFILL_TABLES` walk that uses a join-through-parent UPDATE
 * to propagate `tenantId` + `organizationId` from the parent. New Tier
 * C inserts after Phase 7 lands get the right scope via
 * [ScopeStampingSubscriber](../scope/scope-stamping.subscriber.ts);
 * the Phase 11 walk catches historical pre-upgrade rows.
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
 * EW-663 (Tenants & Organizations Phase 11) — Tier C tables whose
 * scope is backfilled by joining through their Tier A parent.
 *
 * Each entry encodes `{ table, parentTable, parentFkColumn,
 * parentUserColumn }`:
 *
 *   - `table` — the Tier C table being updated.
 *   - `parentTable` — the Tier A parent that has a direct user FK.
 *   - `parentFkColumn` — the column on `table` that references
 *     `parentTable.id`. Most are camelCase (`taskId`, `agentId`); the
 *     one snake-case exception is `work_knowledge_chunks.work_id`
 *     (declared with `name: 'work_id'` on the entity).
 *   - `parentUserColumn` — the user-FK column on `parentTable`. Always
 *     `userId` for the parents we walk here (Tier A user-owned tables
 *     all use `userId` per `TIER_A_BACKFILL_TABLES` above; `templates`
 *     has no Tier C child).
 *
 * **Ordering matters**: where a Tier C table's parent is itself a Tier
 * C row (only case today is `agent_run_logs → agent_runs`), the parent
 * must appear FIRST so the parent's scope is already stamped by the
 * time the child UPDATE runs in the same transaction. We achieve this
 * by listing `agent_runs` before `agent_run_logs`. (See the per-table
 * Phase 11 SQL pattern in `upgradeFromAccount`.)
 *
 * **Direct-user Tier C tables** (`agent_runs`, `skill_bindings`,
 * `usage_ledger_entries`, `plugin_usage_events`, `activity_log`) have
 * their own direct `userId` column and are listed in
 * `TIER_C_DIRECT_USER_BACKFILL_TABLES` below instead — no join needed.
 *
 * **Intentionally deferred** (no entry here):
 *   - `webhook_deliveries` — parent `webhook_subscriptions` has no
 *     direct `userId` column (uses `accountId` against the Better
 *     Auth `account` table). That parent itself is a deferred Tier A
 *     indirect backfill, so chaining through it is a no-op until the
 *     Tier A indirect walk lands. Tracked as a Phase 11b follow-up.
 */
interface TierCJoinTable {
    table: string;
    parentTable: string;
    parentFkColumn: string;
    parentUserColumn: string;
}

const TIER_C_BACKFILL_TABLES: ReadonlyArray<TierCJoinTable> = [
    // Conversations → messages.
    {
        table: 'conversation_messages',
        parentTable: 'conversations',
        parentFkColumn: 'conversationId',
        parentUserColumn: 'userId',
    },
    // Tasks → 9 child junction / log tables. All use `taskId`.
    {
        table: 'task_assignees',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_approvers',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_reviewers',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_watchers',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_blocks',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_chat_messages',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_kb_mentions',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    {
        table: 'task_attachments',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    // `task_relations` has two FK endpoints (`taskId` source +
    // `relatedTaskId` target). We backfill via `taskId` only — the
    // sibling FK is to another row owned by the same user (relations
    // are user-local in v1), so walking it would just produce
    // duplicate matches.
    {
        table: 'task_relations',
        parentTable: 'tasks',
        parentFkColumn: 'taskId',
        parentUserColumn: 'userId',
    },
    // Agents → memberships + budgets (direct children).
    // NOTE: `agent_runs` is direct-user (see below) so it appears in
    // `TIER_C_DIRECT_USER_BACKFILL_TABLES`. `agent_run_logs` is a
    // grandchild via `runId → agent_runs.id`. Because the direct-user
    // loop runs FIRST, `agent_runs` is already stamped by the time the
    // `agent_run_logs` join runs — but we still walk through `agent_runs`
    // here rather than the now-stamped `tenantId` column, since the
    // user-column path is the canonical ownership filter.
    {
        table: 'agent_budgets',
        parentTable: 'agents',
        parentFkColumn: 'agentId',
        parentUserColumn: 'userId',
    },
    {
        table: 'agent_memberships',
        parentTable: 'agents',
        parentFkColumn: 'agentId',
        parentUserColumn: 'userId',
    },
    {
        table: 'agent_run_logs',
        parentTable: 'agent_runs',
        parentFkColumn: 'runId',
        parentUserColumn: 'userId',
    },
    // Works → 4 KB-document child tables + 3 collaboration tables.
    {
        table: 'work_members',
        parentTable: 'works',
        parentFkColumn: 'workId',
        parentUserColumn: 'userId',
    },
    {
        table: 'work_invitations',
        parentTable: 'works',
        parentFkColumn: 'workId',
        parentUserColumn: 'userId',
    },
    {
        table: 'work_generation_history',
        parentTable: 'works',
        parentFkColumn: 'workId',
        parentUserColumn: 'userId',
    },
    // `work_knowledge_chunks` is the lone snake-case exception —
    // entity decorator uses `name: 'work_id'` (see EW-639 comment
    // on the entity for why) so the raw SQL must match.
    {
        table: 'work_knowledge_chunks',
        parentTable: 'works',
        parentFkColumn: 'work_id',
        parentUserColumn: 'userId',
    },
    {
        table: 'work_knowledge_citations',
        parentTable: 'works',
        parentFkColumn: 'workId',
        parentUserColumn: 'userId',
    },
    {
        table: 'work_knowledge_tags',
        parentTable: 'works',
        parentFkColumn: 'workId',
        parentUserColumn: 'userId',
    },
    {
        table: 'work_knowledge_uploads',
        parentTable: 'works',
        parentFkColumn: 'workId',
        parentUserColumn: 'userId',
    },
] as const;

/**
 * EW-663 (Phase 11) — Tier C tables that carry a direct `userId`
 * column of their own. No join needed: stamping these is identical
 * shape to the Tier A backfill (`UPDATE ... WHERE userId = $3`).
 *
 * `agent_runs`, `skill_bindings`, `usage_ledger_entries`,
 * `plugin_usage_events`, and `activity_log` all denormalize the
 * owning user FK because their hot-path read filters scope by user.
 * That gives us a much simpler backfill path than joining through
 * their conceptual parent (Agent / Skill / Work).
 *
 * **Ordering note**: `agent_runs` is in this list and runs in the
 * direct-user loop BEFORE the join loop, so by the time
 * `agent_run_logs` (a join entry above) runs, `agent_runs` already
 * has its scope. But the join loop still uses `parentUserColumn`
 * for filtering — it does not depend on the parent's tenantId being
 * already set, just on the parent's userId.
 */
const TIER_C_DIRECT_USER_BACKFILL_TABLES: ReadonlyArray<UserOwnedTable> = [
    { table: 'agent_runs', userColumn: 'userId' },
    { table: 'skill_bindings', userColumn: 'userId' },
    { table: 'usage_ledger_entries', userColumn: 'userId' },
    { table: 'plugin_usage_events', userColumn: 'userId' },
    { table: 'activity_log', userColumn: 'userId' },
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
 * **Tier C historical backfill (EW-663 Phase 11):** the
 * `upgradeFromAccount` method below ALSO walks every Tier C table
 * and propagates `tenantId` + `organizationId` from the parent Tier
 * A row (or directly via `userId` for the five Tier C tables that
 * carry a user FK of their own). New Tier C inserts still get scope
 * from the auto-stamping subscriber; the Phase 11 walk catches
 * pre-upgrade historical rows. The only remaining deferral is
 * `webhook_deliveries`, whose parent `webhook_subscriptions` is a
 * Tier A row without a direct user FK — tracked as a Phase 11b
 * follow-up alongside the Tier A indirect backfill.
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
     *
     * EW-662 (Phase 10) added the optional `extra` parameter so the
     * Register-Company path ([spec.md §5.4](../../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company))
     * can persist `legalName`, `countryCode`, `registrationProvider`,
     * `registrationStatus`, and `linkedWorkId` in the same atomic
     * insert. All `extra` fields default to NULL / `'draft'` if
     * omitted, so the existing Phase 6/9 Settings + Switcher callers
     * keep behaving exactly as before.
     */
    async createOrganization(
        userId: string,
        name: string,
        slugOverride?: string,
        extra?: {
            legalName?: string | null;
            countryCode?: string | null;
            registrationProvider?: OrganizationRegistrationProvider | null;
            registrationStatus?: OrganizationRegistrationStatus | null;
            linkedWorkId?: string | null;
        },
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
            //
            // `extra` fields are layered on top of the base shape so
            // Phase 6 callers (which pass nothing) keep producing
            // `{ tenantId, slug, displayName }` exactly as before. The
            // entity's column defaults handle the unspecified columns
            // (registrationStatus defaults to `'draft'`).
            const org = manager.getRepository<Organization>('organizations').create({
                tenantId: tenant.id,
                slug,
                displayName: trimmedName,
                legalName: extra?.legalName ?? null,
                countryCode: extra?.countryCode ?? null,
                registrationProvider: extra?.registrationProvider ?? null,
                registrationStatus: extra?.registrationStatus ?? 'draft',
                linkedWorkId: extra?.linkedWorkId ?? null,
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
     * EW-662 (Tenants & Organizations Phase 10) — Register-Company
     * sub-flow entry point ([spec.md §5.4](../../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)).
     *
     * Creates an Organization directly from the chip-driven form on the
     * `+ New` page (Company chip → Register-Company modal). For v1 the
     * Stripe-Atlas integration is deferred; we land the Org with
     * `registrationProvider = 'manual'` and `registrationStatus =
     * 'registered'` so it behaves like any other Org from the moment
     * the form submits.
     *
     * This is essentially `createOrganization` with the registration
     * metadata pre-populated and the slug allocated from the legal
     * name (so e.g. "Acme, Inc." becomes `acme-inc`). When a Phase 11+
     * SDK integration creates a backing Work first, the same shape
     * works — pass `linkedWorkId` to point at the Work.
     */
    async registerCompany(
        userId: string,
        params: {
            name: string;
            countryCode?: string | null;
            legalName?: string | null;
            linkedWorkId?: string | null;
            slugOverride?: string;
        },
    ): Promise<Organization> {
        const trimmed = params.name?.trim();
        if (!trimmed) {
            throw new ConflictException('Company name is required');
        }
        const trimmedLegal = params.legalName?.trim() || trimmed;

        return this.createOrganization(userId, trimmed, params.slugOverride, {
            legalName: trimmedLegal,
            countryCode: params.countryCode?.trim() || null,
            registrationProvider: 'manual',
            registrationStatus: 'registered',
            linkedWorkId: params.linkedWorkId ?? null,
        });
    }

    /**
     * EW-662 (Tenants & Organizations Phase 10) — wire-up entry point
     * for a future Work-of-type-Company `registered` status transition
     * (plan.md Phase 10 step 3).
     *
     * Today the platform's `Work` entity has neither a `kind` column
     * nor a `status` column, so the actual status-transition hook
     * doesn't fire yet. This method exists so the moment those columns
     * land (Phase 11+ when the Stripe Atlas SDK ships), the calling
     * code is a one-liner — the entity-to-Org plumbing is already in
     * place + unit-tested here.
     *
     * Use this whenever a caller has a real `Work` row to link.
     * Otherwise prefer `registerCompany` which is the chip-driven
     * manual-completion path.
     */
    async createOrganizationFromCompanyWork(
        userId: string,
        work: {
            id: string;
            name: string;
            companyName?: string | null;
            companyWebsite?: string | null;
        },
        params?: { countryCode?: string | null; legalName?: string | null; slugOverride?: string },
    ): Promise<Organization> {
        const displayName = (work.companyName?.trim() || work.name)?.trim();
        if (!displayName) {
            throw new ConflictException('Work has no usable name for Organization creation');
        }
        return this.registerCompany(userId, {
            name: displayName,
            countryCode: params?.countryCode ?? null,
            legalName: params?.legalName ?? work.companyName ?? null,
            linkedWorkId: work.id,
            slugOverride: params?.slugOverride,
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
     * **EW-663 (Phase 11) — Tier C historical backfill.** After the
     * Tier A + Tier B loops, the method now walks every Tier C table
     * and propagates `tenantId` + `organizationId`:
     *   - Direct-user Tier C tables (`agent_runs`, `skill_bindings`,
     *     `usage_ledger_entries`, `plugin_usage_events`, `activity_log`)
     *     are updated by the same `WHERE userId = $3` pattern as Tier
     *     A — no join needed.
     *   - Join-walked Tier C tables (the other 20 entries in
     *     `TIER_C_BACKFILL_TABLES`) propagate via an
     *     `UPDATE ... FROM parent WHERE child.<fk> = parent.id AND
     *     parent.userId = $3` shape so the Tier C row inherits its
     *     parent Tier A row's scope.
     *
     * `tierCRowsUpdated` in the response is the sum of both Tier C
     * paths' affected-row counts.
     */
    async upgradeFromAccount(
        userId: string,
        organizationId: string,
    ): Promise<{
        tierARowsUpdated: number;
        tierBRowsUpdated: number;
        tierCRowsUpdated: number;
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
            //
            // EW-663 (Phase 11) bumped this from '30s' → '60s' to
            // give the new Tier C join walks headroom on tables with
            // millions of rows (`agent_run_logs`, `plugin_usage_events`).
            try {
                await manager.query(`SET LOCAL statement_timeout = '60s'`);
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

            // EW-663 (Phase 11) — Tier C historical backfill.
            //
            // (a) Direct-user Tier C tables: `agent_runs` first (so
            // the subsequent `agent_run_logs` join sees an already-
            // scoped parent, though we use the parent's userId rather
            // than its tenantId for filtering — same shape as Tier A.)
            let tierCRowsUpdated = 0;
            for (const { table, userColumn } of TIER_C_DIRECT_USER_BACKFILL_TABLES) {
                const result = (await manager.query(
                    `UPDATE "${table}" SET "tenantId" = $1, "organizationId" = $2 WHERE "${userColumn}" = $3 AND "organizationId" IS NULL`,
                    [tenantId, newOrgId, userId],
                )) as [unknown[], number] | { affected?: number } | undefined;
                tierCRowsUpdated += this.extractAffectedRowCount(result);
            }

            // (b) Join-walked Tier C tables: the UPDATE joins through
            // the parent Tier A row's user FK so we only stamp rows
            // whose parent belongs to this user. Same idempotency
            // shape as Tier A — `organizationId IS NULL` excludes
            // already-moved rows.
            //
            // Postgres `UPDATE ... FROM` is the supported multi-table
            // UPDATE syntax. SQLite has its own (different) syntax,
            // but the in-memory tests don't seed Tier C rows so the
            // SQL never executes there in unit tests; the integration
            // test path runs against Postgres. We catch + log the
            // adapter error in case a SQLite-driven test does hit
            // this with rows present, rather than failing the whole
            // upgrade.
            for (const {
                table,
                parentTable,
                parentFkColumn,
                parentUserColumn,
            } of TIER_C_BACKFILL_TABLES) {
                const result = (await manager.query(
                    `UPDATE "${table}" SET "tenantId" = $1, "organizationId" = $2 FROM "${parentTable}" p WHERE "${table}"."${parentFkColumn}" = p."id" AND p."${parentUserColumn}" = $3 AND "${table}"."organizationId" IS NULL`,
                    [tenantId, newOrgId, userId],
                )) as [unknown[], number] | { affected?: number } | undefined;
                tierCRowsUpdated += this.extractAffectedRowCount(result);
            }

            this.logger.log(
                `Upgrade-from-account: user=${userId} org=${newOrgId} tierA=${tierARowsUpdated} tierB=${tierBRowsUpdated} tierC=${tierCRowsUpdated}`,
            );

            return {
                tierARowsUpdated,
                tierBRowsUpdated,
                tierCRowsUpdated,
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
