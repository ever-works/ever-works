import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { McpConnectionsService, type AgentMcpServerState } from '@ever-works/agent/mcp';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { SetAgentMcpBindingDto } from './dto/mcp-connection.dto';

/**
 * Agent Plugins MCP slice (plan T27) — per-agent MCP server bindings.
 *
 *   GET    /api/agents/:agentId/mcp-servers                 all connections +
 *          effective state (incl. inherited-from-tenant flag)
 *   PUT    /api/agents/:agentId/mcp-servers/:connectionId   {enabled} upsert
 *          the agent-level override row
 *   DELETE /api/agents/:agentId/mcp-servers/:connectionId   remove the
 *          override → revert to tenant inheritance
 *
 * A foreign agentId or connectionId resolves to 404 (no existence leak).
 */
@ApiTags('mcp-connections')
@Controller('api/agents/:agentId/mcp-servers')
export class AgentMcpServersController {
    constructor(private readonly service: McpConnectionsService) {}

    @Get()
    @ApiOperation({ summary: "List all connections with this agent's effective binding state." })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
    ): Promise<{ data: AgentMcpServerState[] }> {
        return { data: await this.service.listForAgent(auth.userId, agentId) };
    }

    @Put(':connectionId')
    @ApiOperation({ summary: 'Set the agent-level override (enabled=false narrows inheritance).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async set(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Param('connectionId', ParseUUIDPipe) connectionId: string,
        @Body() body: SetAgentMcpBindingDto,
    ): Promise<AgentMcpServerState> {
        return this.service.setAgentBinding(auth.userId, agentId, connectionId, body.enabled);
    }

    @Delete(':connectionId')
    @ApiOperation({ summary: 'Remove the agent-level override — revert to tenant inheritance.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async clear(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Param('connectionId', ParseUUIDPipe) connectionId: string,
    ): Promise<AgentMcpServerState> {
        return this.service.clearAgentBinding(auth.userId, agentId, connectionId);
    }
}
