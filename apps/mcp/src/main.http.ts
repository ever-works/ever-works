import 'reflect-metadata';

process.env.MCP_TRANSPORT = 'streamable-http';

async function bootstrap() {
	const { NestFactory } = await import('@nestjs/core');
	const { AppModule } = await import('./app.module.js');
	const { McpConfigService } = await import('./config/mcp-config.service.js');

	const app = await NestFactory.create(AppModule);
	const config = app.get(McpConfigService);

	// Security: restrict cross-origin browser access to the MCP HTTP transport.
	// The endpoint authenticates via custom headers (Authorization Bearer +
	// x-ever-works-jwt), so a malicious web page in a victim's browser must not
	// be able to issue credentialed cross-origin requests against a network-
	// reachable MCP server. Do NOT reflect arbitrary origins: a static array
	// still makes the `cors` package emit Access-Control-Allow-Credentials for
	// evil origins, so use a callback that only echoes allow-listed ones —
	// matching the shape used by apps/api/src/main.ts and the internal-cli serve
	// command. Legitimate MCP clients are non-browser (CLI/IDE/agent runtimes)
	// and send no Origin header, so they are unaffected.
	const configuredOrigins =
		(process.env.EVER_WORKS_MCP_ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS)
			?.split(',')
			.map((o) => o.trim())
			.filter(Boolean) ?? [];
	const allowedOrigins =
		configuredOrigins.length > 0 ? configuredOrigins : ['http://localhost:3000', 'http://127.0.0.1:3000'];
	app.enableCors({
		origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
			// Same-origin / non-browser requests (no Origin header) are allowed.
			if (!origin || allowedOrigins.includes(origin)) {
				callback(null, true);
			} else {
				callback(null, false);
			}
		},
		credentials: true
	});

	await app.listen(config.httpPort);

	console.log(`Ever Works MCP server (HTTP) listening on port ${config.httpPort}`);
	console.log(`MCP endpoint: /mcp (port ${config.httpPort})`);
}

bootstrap().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
