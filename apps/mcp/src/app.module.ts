import { Module, OnApplicationBootstrap, Inject } from '@nestjs/common';
import { McpModule, McpTransportType } from '@rekog/mcp-nest';
import { McpConfigModule } from './config/config.module.js';
import { ApiClientModule } from './api-client/api-client.module.js';
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
		ApiClientModule,
		OpenApiToolsModule
	],
	controllers: isHttp ? [HealthController] : [],
	providers: [ToolRegistrationService, ApiKeyGuard, PingTool, RegisterWorkTool, ...KB_TOOL_PROVIDERS]
})
export class AppModule implements OnApplicationBootstrap {
	constructor(@Inject(ToolRegistrationService) private readonly toolRegistration: ToolRegistrationService) {}

	onApplicationBootstrap() {
		this.toolRegistration.registerTools();
	}
}
