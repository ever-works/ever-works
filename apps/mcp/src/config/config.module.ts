import { Module, Global } from '@nestjs/common';
import { McpConfigService } from './mcp-config.service.js';

@Global()
@Module({
	providers: [McpConfigService],
	exports: [McpConfigService]
})
export class McpConfigModule {}
