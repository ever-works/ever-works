import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServerConnection } from '../entities/mcp-server-connection.entity';
import { PluginUsageEvent } from '../entities/plugin-usage-event.entity';
import { AgentMcpServerBinding } from '../entities/agent-mcp-server-binding.entity';
import { Agent } from '../entities/agent.entity';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import { PluginUsageRepository } from '../database/repositories/plugin-usage.repository';
import { AgentMcpServerBindingRepository } from '../database/repositories/agent-mcp-server-binding.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { McpClientService } from './mcp-client.service';
import { McpConnectionsService } from './mcp-connections.service';
import { McpToolSource } from './mcp-tool-source';

/**
 * Agent Plugins MCP slice (docs/specs/features/agent-plugins plan §2.4)
 * — the agent-side module that owns the manual MCP connection registry,
 * per-agent bindings, and the SDK-backed MCP client.
 *
 * The API-side `McpConnectionsModule` imports this one + mounts the
 * controllers; the api-side @Global() AgentsModule binds
 * `AGENT_MCP_TOOL_SOURCE` to the exported `McpToolSource` so agent runs
 * pick up MCP tools through the existing funnel.
 *
 * Execution is API-side only (the Trigger.dev worker is an RPC proxy
 * back to the API), so the MCP client lives here and nowhere else.
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            McpServerConnection,
            AgentMcpServerBinding,
            Agent,
            PluginUsageEvent,
        ]),
        ActivityLogModule,
    ],
    providers: [
        McpServerConnectionRepository,
        PluginUsageRepository,
        AgentMcpServerBindingRepository,
        AgentRepository,
        McpClientService,
        McpConnectionsService,
        McpToolSource,
    ],
    exports: [
        McpServerConnectionRepository,
        AgentMcpServerBindingRepository,
        McpClientService,
        McpConnectionsService,
        McpToolSource,
    ],
})
export class McpModule {}
