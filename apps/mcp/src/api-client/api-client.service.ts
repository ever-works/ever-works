import { Injectable, Inject, Scope, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { McpConfigService } from '../config/mcp-config.service.js';
import { ApiError } from './api-error.js';
import { sanitizeResponse } from './sanitize.js';

/**
 * H-21 — request-scoped HTTP client.
 *
 * Reads the per-user JWT (if any) from the incoming MCP request and
 * forwards it to the upstream API. The shared `EVER_WORKS_API_KEY` is
 * still used as a fallback when the request didn't carry a JWT (`hybrid`
 * or `shared-key` modes). In `per-user-jwt` mode, the shared key is
 * never sent — only the caller's JWT — so cross-tenant access via a
 * leaked platform key becomes impossible.
 */
@Injectable({ scope: Scope.REQUEST })
export class ApiClientService {
	constructor(
		@Inject(McpConfigService) private readonly config: McpConfigService,
		// REQUEST is the inbound HTTP request when MCP is running over the
		// HTTP transport. For stdio transport the request is absent and we
		// fall back to the shared key.
		@Optional() @Inject(REQUEST) private readonly request: { __callerJwt?: string } | null = null,
	) {}

	async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.config.apiUrl}${path}`;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		// H-21: forward the per-user JWT if present, fall back to shared key.
		// In `per-user-jwt` mode the shared key is null on the config, so
		// we never send it even if a JWT is missing — the upstream will reject.
		const callerJwt = this.request?.__callerJwt;
		if (callerJwt) {
			headers['Authorization'] = `Bearer ${callerJwt}`;
		} else if (this.config.apiKey) {
			headers['x-api-key'] = this.config.apiKey;
		}

		const init: RequestInit = {
			method,
			headers,
			signal: AbortSignal.timeout(30_000),
		};

		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const response = await fetch(url, init);

		let data: unknown;
		const contentType = response.headers.get('content-type');
		if (contentType?.includes('application/json')) {
			data = await response.json();
		} else {
			data = await response.text();
		}

		if (!response.ok) {
			const message =
				data && typeof data === 'object' && 'message' in data
					? String((data as Record<string, unknown>).message)
					: `HTTP ${response.status} ${response.statusText}`;
			throw new ApiError(response.status, message, data);
		}

		return sanitizeResponse(data as T);
	}
}
