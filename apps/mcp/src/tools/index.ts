import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EverWorksClient } from '../client.js';
import { registerDirectoryTools } from './directories.js';
import { registerGenerationTools } from './generation.js';
import { registerItemTools } from './items.js';
import { registerDeployTools } from './deploy.js';
import { registerPluginTools } from './plugins.js';

export function registerAllTools(server: McpServer, client: EverWorksClient): void {
	registerDirectoryTools(server, client);
	registerGenerationTools(server, client);
	registerItemTools(server, client);
	registerDeployTools(server, client);
	registerPluginTools(server, client);
}
