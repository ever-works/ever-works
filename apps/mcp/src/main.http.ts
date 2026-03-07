import 'reflect-metadata';

process.env.MCP_TRANSPORT = 'streamable-http';

async function bootstrap() {
	const { NestFactory } = await import('@nestjs/core');
	const { AppModule } = await import('./app.module.js');
	const { McpConfigService } = await import('./config/mcp-config.service.js');

	const app = await NestFactory.create(AppModule);
	const config = app.get(McpConfigService);

	await app.listen(config.httpPort);

	console.log(`Ever Works MCP server (HTTP) listening on port ${config.httpPort}`);
	console.log(`MCP endpoint: /mcp (port ${config.httpPort})`);
}

bootstrap().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
