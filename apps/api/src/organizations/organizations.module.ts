import { Module } from '@nestjs/common';
import {
    DatabaseModule,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { TenantBootstrapService } from '../scope/tenant-bootstrap.service';
import { UsersModule } from '../users/users.module';
import { OrganizationService } from './organization.service';
import { OrganizationMembershipService } from './organization-membership.service';
import { OrganizationOwnershipGuard } from './guards/organization-ownership.guard';
import { OrganizationsController } from './organizations.controller';
import { WorkRegisteredListener } from './work-registered.listener';

/**
 * EW-658 (Tenants & Organizations Phase 6) — Organizations module.
 *
 * Wires up `OrganizationService`, `OrganizationsController`, and
 * `TenantBootstrapService`. The latter lives logically in the `scope/`
 * tree (it pairs with `ScopeContextService`), but it's provided here
 * because the Organization-create flow is its only caller today and
 * making it a peer provider keeps the DI graph flat. If a future
 * phase adds a second caller (e.g. accept-Org-invite), the
 * `TenantBootstrapService` can graduate to `ScopeModule` and this
 * module just imports it.
 *
 * Imports `UsersModule` so `UsernameAllocatorService` (Phase 0) is
 * resolved as a single shared instance — both `TenantBootstrapService`
 * and `OrganizationService` consume it for slug allocation.
 */
@Module({
    // EW-665 (Phase 13) — `WorkModule` provides `WorkLifecycleService`, used
    // by the Register-Company controller to land + transition the backing
    // Company Work. `WorkModule` doesn't import Organizations, so no cycle.
    imports: [DatabaseModule, UsersModule, WorkModule],
    providers: [
        UserRepository,
        TenantRepository,
        OrganizationRepository,
        // EW-665 (Phase 13) — `WorkRegisteredListener` loads the full
        // Company Work to read its name/website before spawning the Org.
        WorkRepository,
        TenantBootstrapService,
        OrganizationService,
        // Reusable tenant-ownership guard for raw
        // `/api/organizations/:orgId/...` routes (extracted from
        // OrgKbController's inline assertOrgAccess). Exported so other
        // feature modules with `:orgId` routes (e.g. WorksModule's
        // OrgKbController) share one audited implementation.
        OrganizationMembershipService,
        // EW-711 (security-audit C2) — fail-closed `CanActivate` wrapper over
        // OrganizationMembershipService so raw `:orgId` routes are authorized
        // declaratively/by-default (closes the "a future route forgets the
        // inline call" gap). Exported for feature modules with `:orgId` routes
        // (e.g. WorksModule's OrgKbController).
        OrganizationOwnershipGuard,
        // EW-665 (Phase 13) — turns a Company Work's `→ registered`
        // transition (the `work.status.changed` event) into an Org.
        WorkRegisteredListener,
    ],
    controllers: [OrganizationsController],
    exports: [
        OrganizationService,
        OrganizationMembershipService,
        OrganizationOwnershipGuard,
        TenantBootstrapService,
        // EW-742 P3.2 T22 — exported so TriggerInternalModule can
        // expose findById through the remote-proxy controller for
        // the worker-host resolveForOrganization path.
        OrganizationRepository,
    ],
})
export class OrganizationsModule {}
