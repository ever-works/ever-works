import { Module } from '@nestjs/common';
import { AgentsModule } from '@ever-works/agent/agents';
import { PolicyModule } from '@ever-works/agent/policy';
import { AgentCapabilitiesController } from './agent-capabilities.controller';

/**
 * Agent Capabilities tab — thin API module over the agent-side
 * `AgentsModule` (owner-scoped Agent reads) and `PolicyModule` (the
 * tool-grant matrix: resolution, narrowing rule, single decision point).
 *
 * A SEPARATE module rather than a new provider on `AgentsModule` so the
 * pinned module shape (`agents.module.spec.ts`) stays untouched and the
 * composed endpoint remains an additive leaf: it owns no rows, only
 * reads through the two services' existing owner checks.
 *
 * Mutations live elsewhere on purpose — grant rows through
 * `ToolGrantsApiModule` (`PUT/DELETE /api/tool-grants`), `initScript`
 * through the Agents PATCH.
 */
@Module({
    imports: [AgentsModule, PolicyModule],
    controllers: [AgentCapabilitiesController],
})
export class AgentCapabilitiesApiModule {}
