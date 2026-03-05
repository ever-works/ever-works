export interface McpConfig {
	apiUrl: string;
	apiKey: string;
	httpPort: number;
}

export function loadConfig(): McpConfig {
	const apiKey = process.env.EVER_WORKS_API_KEY;
	if (!apiKey) {
		console.error('EVER_WORKS_API_KEY environment variable is required.');
		console.error('Generate one at Settings > API Keys in the Ever Works dashboard.');
		process.exit(1);
	}

	let apiUrl = process.env.EVER_WORKS_API_URL || 'http://localhost:3100';

	// Normalize URL to ensure it ends with /api
	if (!apiUrl.endsWith('/api')) {
		apiUrl = apiUrl.endsWith('/') ? apiUrl + 'api' : apiUrl + '/api';
	}

	const httpPort = parseInt(process.env.EVER_WORKS_MCP_PORT || '3200', 10);
	if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
		console.error(
			`EVER_WORKS_MCP_PORT must be a valid port number (1-65535), got: "${process.env.EVER_WORKS_MCP_PORT}"`
		);
		process.exit(1);
	}

	return { apiUrl, apiKey, httpPort };
}
