import { Injectable } from '@nestjs/common';

/**
 * H-21 — MCP auth modes.
 *
 * - `shared-key` (legacy):  request authenticates with shared API key,
 *   upstream calls use that same key (no per-user identity). Coarse.
 * - `shared-key-jwt`:        request must present BOTH shared key AND a
 *   per-user JWT in `x-ever-works-jwt` header; upstream calls forward
 *   the JWT, restoring per-user tenancy on the API side.
 * - `per-user-jwt`:          request authenticates with a per-user JWT
 *   (no shared key); upstream calls forward the JWT.
 * - `hybrid` (default):      accept any of the above. Lets early tenants
 *   keep using the shared key while gradually migrating to per-user JWT.
 *
 * Configured via `EVER_WORKS_MCP_AUTH_MODE`.
 */
export type McpAuthMode = 'shared-key' | 'shared-key-jwt' | 'per-user-jwt' | 'hybrid';

@Injectable()
export class McpConfigService {
	readonly apiUrl: string;
	readonly apiKey: string | null;
	readonly httpPort: number;
	readonly transport: string;
	readonly authMode: McpAuthMode;

	constructor() {
		this.authMode = parseAuthMode(process.env.EVER_WORKS_MCP_AUTH_MODE);

		// H-21: the shared API key is OPTIONAL in `per-user-jwt` mode. In any
		// mode that may accept it (`shared-key`, `shared-key-jwt`, `hybrid`)
		// it must be present.
		const apiKey = process.env.EVER_WORKS_API_KEY?.trim() || null;
		if (this.authMode !== 'per-user-jwt' && !apiKey) {
			throw new Error(
				`EVER_WORKS_API_KEY is required for MCP auth mode "${this.authMode}". ` +
					'Set EVER_WORKS_MCP_AUTH_MODE=per-user-jwt to opt out, or generate a key at Settings > API Keys in the Ever Works dashboard.',
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

	/** True if a request that presents only the shared key should be allowed. */
	allowsSharedKeyOnly(): boolean {
		return this.authMode === 'shared-key' || this.authMode === 'hybrid';
	}

	/** True if a request that presents a per-user JWT should be allowed (with or without shared key). */
	allowsJwt(): boolean {
		return (
			this.authMode === 'shared-key-jwt' ||
			this.authMode === 'per-user-jwt' ||
			this.authMode === 'hybrid'
		);
	}

	/** True if a request must present a per-user JWT (i.e. the shared key alone is insufficient). */
	requiresJwt(): boolean {
		return this.authMode === 'shared-key-jwt' || this.authMode === 'per-user-jwt';
	}
}

function parseAuthMode(raw: string | undefined): McpAuthMode {
	const v = (raw || 'hybrid').trim().toLowerCase();
	if (v === 'shared-key' || v === 'shared-key-jwt' || v === 'per-user-jwt' || v === 'hybrid') {
		return v;
	}
	throw new Error(
		`Invalid EVER_WORKS_MCP_AUTH_MODE: "${raw}". Expected one of: shared-key, shared-key-jwt, per-user-jwt, hybrid.`,
	);
}
