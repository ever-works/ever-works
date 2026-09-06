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
import { AgentPluginsModule } from '../agent-plugins/agent-plugins.module';

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
        // AP-14. AgentPluginsModule is a leaf (two entities, DatabaseModule,
        // and it deliberately provides McpServerConnectionRepository locally
        // rather than importing THIS module), so importing it here cannot
        // cycle — the same argument FacadesModule already makes for the
        // AGENT_PLUGIN_SKILL_SOURCE seam. It binds MCP_STDIO_LAUNCHER, which
        // McpToolSource consumes @Optional() to launch a package's stdio
        // server for the duration of a run.
        //
        // Without this import the token is simply absent from McpToolSource's
        // injector and the @Optional() dependency arrives `undefined` — the
        // failure this repo has already shipped once, where a seam looked
        // wired because the provider existed SOMEWHERE in the app.
        AgentPluginsModule,
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
