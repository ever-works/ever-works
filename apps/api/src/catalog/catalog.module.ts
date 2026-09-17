import { Module } from '@nestjs/common';
import { AgentsModule } from '@ever-works/agent/agents';
import { FacadesModule } from '@ever-works/agent/facades';
import { PlaybookReadinessService } from '@ever-works/agent/services';
import { AuthModule } from '../auth/auth.module';
import { CatalogController } from './catalog.controller';
import { PlaybookCatalogService } from './playbook-catalog.service';

/**
 * Capability & playbook catalogue (AW-21) — API module.
 *
 * Read-only. `FacadesModule` supplies `PlaybookCatalogFacadeService` (the
 * fan-out across enabled playbook-provider plugins); the agent-side
 * `AgentsModule` supplies `AgentRepository`, which readiness uses to suggest
 * a free Agent name (it is feature-owned and not exported by the api-side
 * global module; modules are singletons, so importing it adds no second
 * instance). The plugin registry readiness asks about capabilities is global.
 * `AuthModule` is imported because the controller's `AuthSessionGuard` is
 * resolved through DI.
 *
 * The other catalogue sections read their own existing endpoints, so this
 * module imports none of their modules.
 */
@Module({
    imports: [FacadesModule, AgentsModule, AuthModule],
    controllers: [CatalogController],
    providers: [PlaybookReadinessService, PlaybookCatalogService],
})
export class CatalogModule {}
