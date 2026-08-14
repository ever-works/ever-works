import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AgentCapabilitiesPayload, AgentCapabilityToolRow } from '@ever-works/contracts';
import { AgentsService, buildAgentToolCatalog } from '@ever-works/agent/agents';
import { ToolGrantService, decideToolGrant } from '@ever-works/agent/policy';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Agent Capabilities tab — the composed read.
 *
 *   GET /api/agents/:id/capabilities
 *
 * One request answers the whole tab: the static tool catalog (derived
 * from `resolveAllowedTools` — see `buildAgentToolCatalog`), the
 * tool-grant chain resolved for this Agent (tenant → organization →
 * Work → Agent over the platform default, per-layer rejected patterns
 * included), the per-tool effective decision, the 8 permission flags
 * (read-only here; edited on Settings) and the init script.
 *
 * Mutations deliberately REUSE existing endpoints instead of growing new
 * ones: the agent-scope grant row is written through
 * `PUT /api/tool-grants` / `DELETE /api/tool-grants/:id` (owner-checked
 * there), and `initScript` rides `PATCH /api/agents/:id`.
 *
 * Ownership: `AgentsService.getOne` 404s a cross-user Agent (never 403 —
 * no existence leak), so everything composed AFTER it is already scoped
 * to the caller's own row. Grant rows are additionally read through
 * `ToolGrantService.list(userId)` — owner-scoped by construction.
 */
@ApiTags('agents')
@Controller('api/agents')
export class AgentCapabilitiesController {
    constructor(
        private readonly agents: AgentsService,
        private readonly toolGrants: ToolGrantService,
    ) {}

    @Get(':id/capabilities')
    @ApiOperation({
        summary:
            'Composed capabilities read for one Agent: tool catalog + resolved tool-grant chain + effective per-tool decision + permissions + init script.',
    })
    @HttpCode(HttpStatus.OK)
    async getCapabilities(
        @Param('id', ParseUUIDPipe) id: string,
        @CurrentUser() auth: AuthenticatedUser,
    ): Promise<AgentCapabilitiesPayload> {
        // Throws 404 for a foreign/unknown Agent before anything else runs.
        const agent = await this.agents.getOne(auth.userId, id);

        const [resolved, storedRows] = await Promise.all([
            this.toolGrants.resolve({ userId: auth.userId, agentId: id }),
            this.toolGrants.list(auth.userId),
        ]);
        const agentRow =
            storedRows.find((row) => row.scopeType === 'agent' && row.scopeId === id) ?? null;

        const permissions = agent.permissions as unknown as Record<string, boolean>;
        const tools: AgentCapabilityToolRow[] = buildAgentToolCatalog().map((entry) => {
            const permissionEnabled = entry.gatedByPermission
                ? Boolean(permissions[entry.gatedByPermission])
                : true;
            const decision = decideToolGrant(
                { matrix: resolved.matrix, chain: resolved.chain },
                entry.name,
            );
            return {
                ...entry,
                permissionEnabled,
                decision,
                effective: permissionEnabled && decision.allowed,
            };
        });

        return {
            agentId: agent.id,
            initScript: agent.initScript,
            permissions,
            tools,
            grants: resolved,
            agentGrantRow: agentRow
                ? {
                      id: agentRow.id,
                      allow: agentRow.allow ?? null,
                      deny: agentRow.deny ?? null,
                      note: agentRow.note ?? null,
                  }
                : null,
        };
    }
}
