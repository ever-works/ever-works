/**
 * Agent Plugins MCP slice — external MCP server connections for agents
 * (docs/specs/features/agent-plugins, plan §2.4, tasks T23–T27).
 */
export * from './mcp.module';
// Re-export the entity types so api callers don't need a deep import
// (TS2305 bug class: an @Module export is not a TS export).
export {
    McpServerConnection,
    MCP_CONNECTION_NAME_PATTERN,
    type McpConnectionTransport,
    type McpConnectionSource,
} from '../entities/mcp-server-connection.entity';
export {
    AgentMcpServerBinding,
    type McpBindingTargetType,
} from '../entities/agent-mcp-server-binding.entity';
export * from './mcp-client.service';
export * from './mcp-connections.service';
export * from './mcp-tool-source';
export * from './mcp-sdk';
