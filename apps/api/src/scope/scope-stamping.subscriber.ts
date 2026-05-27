import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { ScopeContextService } from './scope-context.service';

/**
 * EW-657 (Tenants & Organizations Phase 5b) — TypeORM
 * `EntitySubscriberInterface` that auto-stamps `tenantId` and
 * `organizationId` on every Tier C row insert from the active
 * [`ScopeContextService`](./scope-context.service.ts).
 *
 * **Why a subscriber (not manual wiring in every service):**
 *
 * The plan calls for "service-layer change: every create path that
 * writes a Tier C row must set tenantId and organizationId from the
 * currently active scope context" — across ~20-30 services. The
 * subscriber pattern achieves the same outcome with one
 * mechanically-enforced hook instead of 30 manual call-site edits that
 * a developer can forget in a future PR. Explicit injection of
 * `ScopeContextService` is still preferred for read-side queries (a
 * service that needs to filter by scope should consume the service
 * directly); the subscriber covers the write path so we don't rely on
 * developer memory to keep the multi-Org invariant intact.
 *
 * The set of Tier C tables is locked in by
 * [`tier-c.tenants-orgs.spec.ts`](../../../../packages/agent/src/entities/__tests__/tier-c.tenants-orgs.spec.ts)
 * and by the Phase 5a migration's `TIER_C_TABLES` array. This
 * subscriber detects Tier C rows by checking that the entity declares
 * BOTH a `tenantId` and an `organizationId` column — that shape is
 * the Tier A/C contract per [spec.md §2.3](../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets).
 * Tier A entities will also pass this gate — that's fine. Tier A
 * services should still consume `ScopeContextService` directly for
 * read paths, but the same auto-stamping write-path safety net is
 * equally desirable there. (Tier B entities like `auth_session` get
 * `tenantId` only and are skipped because they lack `organizationId`.)
 *
 * **Behavior on each insert:**
 *
 * - If the row already has `tenantId` set explicitly (e.g., a
 *   `upgrade-from-account` backfill), the subscriber does NOT
 *   overwrite it. Same for `organizationId`. This makes the subscriber
 *   safe to run alongside any manual wiring that might land later.
 * - If the row has `tenantId === undefined`, the subscriber stamps
 *   from `ScopeContextService.getTenantId()` (which may also be
 *   `null` — that's fine; the columns are nullable).
 * - `null` is treated as an explicit choice and is NOT overwritten.
 *   Only `undefined` triggers the auto-stamp. This lets a caller say
 *   "I deliberately want NULL here" by passing `null`.
 *
 * **No-op until Phase 7:** today `ScopeContextService.getScope()`
 * returns `EMPTY_SCOPE` (both fields `null`) because no middleware
 * populates the ALS yet. Phase 7's slug-resolver middleware will set
 * it from `:slug`. Until then this subscriber stamps nulls, which is
 * a no-op (column default is null).
 */
@Injectable()
export class ScopeStampingSubscriber
    implements EntitySubscriberInterface, OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(ScopeStampingSubscriber.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly scopeContext: ScopeContextService,
    ) {}

    onModuleInit(): void {
        // Register on the DataSource. TypeORM subscribers can be
        // declared either via the `subscribers` config option OR by
        // pushing onto `dataSource.subscribers` at runtime; we use the
        // latter so this subscriber lives in apps/api/ (where the
        // ScopeContextService also lives) instead of bleeding into the
        // shared agent package's database.config.ts.
        //
        // Guard against duplicate registration (e.g. HMR-driven module
        // re-init in dev) — pushing twice would have the new + stale
        // instances both fire on every insert. (Greptile P2 on PR #1055.)
        if (!this.dataSource.subscribers.includes(this)) {
            this.dataSource.subscribers.push(this);
            this.logger.debug('ScopeStampingSubscriber registered on DataSource');
        }
    }

    onModuleDestroy(): void {
        // Symmetric removal so HMR / `app.close()` doesn't leave a
        // defunct instance pinned in `dataSource.subscribers` (it'd
        // hold a live reference to the old ScopeContextService and
        // leak memory across reloads). (Greptile P2 on PR #1055.)
        const idx = this.dataSource.subscribers.indexOf(this);
        if (idx !== -1) {
            this.dataSource.subscribers.splice(idx, 1);
        }
    }

    beforeInsert(event: InsertEvent<unknown>): void {
        const entity = event.entity as Record<string, unknown> | undefined;
        if (!entity) {
            return;
        }

        const metadata = event.metadata;
        const hasTenantId = metadata.columns.some((c) => c.propertyName === 'tenantId');
        const hasOrganizationId = metadata.columns.some((c) => c.propertyName === 'organizationId');

        // Skip entities that don't declare BOTH columns. Tier B
        // (auth_session, refresh_tokens, etc.) declares only
        // `tenantId`; we don't auto-stamp those because doing so would
        // require a second code path and Tier B isn't read-filtered by
        // scope today (those tables are queried by userId).
        if (!hasTenantId || !hasOrganizationId) {
            return;
        }

        const scope = this.scopeContext.getScope();

        if (entity.tenantId === undefined) {
            entity.tenantId = scope.tenantId;
        }
        if (entity.organizationId === undefined) {
            entity.organizationId = scope.organizationId;
        }
    }
}
