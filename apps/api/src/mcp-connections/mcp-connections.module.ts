import { Module } from '@nestjs/common';
import { McpModule } from '@ever-works/agent/mcp';
import { AuthModule } from '../auth/auth.module';
import { McpConnectionsController } from './mcp-connections.controller';
import { AgentMcpServersController } from './agent-mcp-servers.controller';

/**
 * Agent Plugins MCP slice — api-side module mounting the connection CRUD
 * (Settings → Connections) + per-agent binding controllers. The domain
 * services live in the agent-side `McpModule`.
 */
@Module({
    imports: [McpModule, AuthModule],
    controllers: [McpConnectionsController, AgentMcpServersController],
})
export class McpConnectionsModule {}
