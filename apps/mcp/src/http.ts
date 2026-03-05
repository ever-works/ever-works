import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './index.js';

async function main() {
	const { server, config } = createServer();

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined
	});

	await server.connect(transport);

	const httpServer = createHttpServer((req, res) => {
		if (req.url === '/mcp') {
			transport.handleRequest(req, res);
		} else if (req.url === '/health') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ status: 'ok' }));
		} else {
			res.writeHead(404);
			res.end('Not found');
		}
	});

	httpServer.listen(config.httpPort, () => {
		console.log(`Ever Works MCP server (HTTP) listening on port ${config.httpPort}`);
		console.log(`MCP endpoint: http://localhost:${config.httpPort}/mcp`);
	});
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
