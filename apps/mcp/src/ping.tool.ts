import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';

@Injectable()
export class PingTool {
	@Tool({
		name: 'ping',
		description: 'Health check — returns pong to verify the MCP server is connected and working',
		parameters: z.object({})
	})
	ping() {
		return { content: [{ type: 'text' as const, text: 'pong' }] };
	}
}
