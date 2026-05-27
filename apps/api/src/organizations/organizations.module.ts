import { Module } from '@nestjs/common';
import {
    DatabaseModule,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { TenantBootstrapService } from '../scope/tenant-bootstrap.service';
import { UsersModule } from '../users/users.module';
import { OrganizationService } from './organization.service';
import { OrganizationsController } from './organizations.controller';

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
    imports: [DatabaseModule, UsersModule],
    providers: [
        UserRepository,
        TenantRepository,
        OrganizationRepository,
        TenantBootstrapService,
        OrganizationService,
    ],
    controllers: [OrganizationsController],
    exports: [OrganizationService, TenantBootstrapService],
})
export class OrganizationsModule {}
