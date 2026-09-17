import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { SharedViewsModule as AgentSharedViewsModule } from '@ever-works/agent/shared-views';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SharedViewOwnerGuard, SharedViewOwnerResolver } from './shared-view-owner.guard';
import { SharedViewPublicController } from './shared-view-public.controller';
import {
    SharedViewPublicExceptionFilter,
    SharedViewPublicHeadersInterceptor,
} from './shared-view-public.http';
import { SharedViewSessionGuard } from './shared-view-session.guard';
import { SharedViewSessionService } from './shared-view-session.service';
import { SharedViewViewDedupe } from './shared-view-view-dedupe';
import { SharedViewsController } from './shared-views.controller';

/**
 * Shared view (AW-18) — api-side module: Settings → Sharing for the owner and
 * the public share-link API for visitors. Domain logic lives in
 * `@ever-works/agent/shared-views`.
 *
 *   - `OrganizationsModule` supplies the `OrganizationOwnershipGuard` +
 *     `OrganizationMembershipService` pair every `:orgId` route reuses.
 *   - `AuthModule` supplies `AuthSessionGuard` for the owner routes.
 *   - `DatabaseModule` supplies the Organization and Tenant repositories the
 *     owner resolver reads.
 *
 * The public controller's two class-based enhancers — the posture filter and
 * the security-header interceptor — are listed as providers as well. Nest
 * already picks controller-declared enhancers up on its own, so this changes
 * no behaviour today; it states the dependency explicitly, and it keeps the
 * pair resolvable from this module the day either of them takes a
 * constructor argument.
 *
 * No background work and no external integration: counting a view is one
 * UPDATE on the exchange path, de-duplicated in memory.
 */
@Module({
    imports: [AgentSharedViewsModule, DatabaseModule, OrganizationsModule, AuthModule],
    controllers: [SharedViewsController, SharedViewPublicController],
    providers: [
        SharedViewOwnerResolver,
        SharedViewOwnerGuard,
        SharedViewSessionService,
        SharedViewSessionGuard,
        SharedViewViewDedupe,
        SharedViewPublicExceptionFilter,
        SharedViewPublicHeadersInterceptor,
    ],
})
export class SharedViewsApiModule {}
