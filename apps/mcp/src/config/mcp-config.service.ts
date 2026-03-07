import { Injectable } from '@nestjs/common';

@Injectable()
export class McpConfigService {
	readonly apiUrl: string;
	readonly apiKey: string;
	readonly httpPort: number;
	readonly transport: string;

	constructor() {
		const apiKey = process.env.EVER_WORKS_API_KEY;
		if (!apiKey) {
			throw new Error(
				'EVER_WORKS_API_KEY environment variable is required. Generate one at Settings > API Keys in the Ever Works dashboard.'
			);
		}
		this.apiKey = apiKey;

		let apiUrl = process.env.EVER_WORKS_API_URL || 'http://localhost:3100';
		if (!apiUrl.endsWith('/api')) {
			apiUrl = apiUrl.endsWith('/') ? apiUrl + 'api' : apiUrl + '/api';
		}
		this.apiUrl = apiUrl;

		const httpPort = parseInt(process.env.EVER_WORKS_MCP_PORT || '3200', 10);
		if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
			throw new Error(
				`EVER_WORKS_MCP_PORT must be a valid port number (1-65535), got: "${process.env.EVER_WORKS_MCP_PORT}"`
			);
		}
		this.httpPort = httpPort;
		this.transport = process.env.MCP_TRANSPORT || 'stdio';
	}
}
