import { Module, OnApplicationBootstrap, Inject, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { McpModule, McpTransportType } from '@rekog/mcp-nest';
import { McpConfigModule } from './config/config.module.js';
import { ApiClientModule } from './api-client/api-client.module.js';
import { CallerContextModule } from './context/caller-context.module.js';
import { CallerContextMiddleware } from './context/caller-context.middleware.js';
import { OpenApiToolsModule } from './openapi-tools/openapi-tools.module.js';
import { ToolRegistrationService } from './openapi-tools/tool-registration.service.js';
import { HealthController } from './health.controller.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { PingTool } from './ping.tool.js';
import { RegisterWorkTool } from './register-work.tool.js';
// EW-643 Phase 3 slice 3 — MCP `kb.*` namespace. Each entry is a
// NestJS-injectable provider whose `@Tool()` decorator the rekog/mcp-nest
// scanner picks up at bootstrap. Integration point for new KB tools.
import { KB_TOOL_PROVIDERS } from './tools/kb/index.js';

const transport =
	process.env.MCP_TRANSPORT === 'streamable-http' ? McpTransportType.STREAMABLE_HTTP : McpTransportType.STDIO;

const isHttp = transport === McpTransportType.STREAMABLE_HTTP;

@Module({
	imports: [
		McpModule.forRoot({
			name: 'ever-works',
			version: '0.1.0',
			capabilities: { tools: {} },
			transport,
			...(isHttp
				? {
						streamableHttp: {
							enableJsonResponse: true,
							sessionIdGenerator: undefined,
							statelessMode: true
						},
						guards: [ApiKeyGuard]
					}
				: {})
		}),
		McpConfigModule,
		CallerContextModule,
		ApiClientModule,
		OpenApiToolsModule
	],
	controllers: isHttp ? [HealthController] : [],
	providers: [
		ToolRegistrationService,
		ApiKeyGuard,
		CallerContextMiddleware,
		PingTool,
		RegisterWorkTool,
		...KB_TOOL_PROVIDERS
	]
})
export class AppModule implements OnApplicationBootstrap, NestModule {
	constructor(@Inject(ToolRegistrationService) private readonly toolRegistration: ToolRegistrationService) {}

	/**
	 * Open the caller-context frame for every inbound HTTP request, before
	 * guards run. Applied to `*` rather than just `/mcp` so any route added
	 * later is covered by default — a route that silently ran outside the
	 * frame would reintroduce exactly the dropped-identity bug this fixes.
	 *
	 * Not applicable to the stdio transport, which serves no HTTP routes;
	 * there the AsyncLocalStorage store is simply absent and
	 * `ApiClientService` falls back to the shared key, as before.
	 */
	configure(consumer: MiddlewareConsumer) {
		if (!isHttp) return;
		consumer.apply(CallerContextMiddleware).forRoutes('*');
	}

	onApplicationBootstrap() {
		this.toolRegistration.registerTools();
	}
}
