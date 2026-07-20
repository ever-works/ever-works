import { Module } from '@nestjs/common';
import { AgentTeamsModule } from '@ever-works/agent/teams';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TeamsController } from './teams.controller';

/**
 * Teams & Prebuilt Companies — api-side module (controller only; domain
 * logic lives in `@ever-works/agent/teams`, missions-pattern split).
 * `OrganizationsModule` supplies the shared `OrganizationOwnershipGuard`
 * + `OrganizationMembershipService` pair every `:orgId` route reuses.
 */
@Module({
    imports: [AgentTeamsModule, OrganizationsModule, AuthModule],
    controllers: [TeamsController],
})
export class TeamsModule {}
