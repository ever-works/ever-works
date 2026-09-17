import { Module } from '@nestjs/common';
import { ModelRoutingModule } from '@ever-works/agent/model-routing';
import { AuthModule } from '@src/auth';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ModelAccountsController } from './model-accounts.controller';
import { ModelPoliciesController } from './model-policies.controller';
import { ModelWorkspaceAccessService } from './model-workspace-access.service';

/**
 * Model accounts (AW-16) — the HTTP surface for a workspace's provider
 * accounts and its model ladder.
 *
 * The domain lives in `@ever-works/agent/model-routing`; this module only
 * authorizes and maps. Organization writes are authorized by the shared
 * membership check (OrganizationsModule imports nothing model-side — no
 * cycle). The route planner the AI facade uses is bound separately, through
 * `FacadesModule`, so a deployment serving no HTTP still routes calls.
 */
@Module({
    imports: [ModelRoutingModule, AuthModule, OrganizationsModule],
    controllers: [ModelAccountsController, ModelPoliciesController],
    providers: [ModelWorkspaceAccessService],
})
export class ModelRoutingApiModule {}
