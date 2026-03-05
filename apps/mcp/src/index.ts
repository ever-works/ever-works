import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type McpConfig } from './config.js';
import { EverWorksClient } from './client.js';
import { registerAllTools } from './tools/index.js';

export function createServer(): { server: McpServer; config: McpConfig } {
	const config = loadConfig();
	const client = new EverWorksClient(config.apiUrl, config.apiKey);

	const server = new McpServer({
		name: 'ever-works',
		version: '0.1.0',
	});

	registerAllTools(server, client);

	return { server, config };
}
