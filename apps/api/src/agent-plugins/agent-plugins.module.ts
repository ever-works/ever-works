import { Module } from '@nestjs/common';
import { AgentPluginsModule as AgentSideAgentPluginsModule } from '@ever-works/agent/agent-plugins';
import { DatabaseModule } from '@ever-works/agent/database';
import { AgentPluginsController } from './agent-plugins.controller';

/**
 * API-side Agent Plugins module.
 *
 * Imports the agent-side module rather than listing its services in
 * `providers`. Listing them locally would create a SECOND instance with an
 * unresolvable constructor — both sibling templates (`skills`, `mcp-connections`)
 * import their agent-side module for exactly this reason.
 *
 * `DatabaseModule` is imported because the guards and repositories that
 * later write routes will need resolve `UserRepository` through it; a module
 * mounting an admin-guarded controller without it fails to instantiate the
 * guard at REQUEST time, which no unit test and no `generate:openapi` run
 * catches — that command runs in preview mode and never instantiates
 * providers.
 */
@Module({
    imports: [AgentSideAgentPluginsModule, DatabaseModule],
    controllers: [AgentPluginsController],
})
export class AgentPluginsApiModule {}
