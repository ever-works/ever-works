import { Injectable, Inject, Scope, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { McpConfigService } from '../config/mcp-config.service.js';
import { CallerContextService } from '../context/caller-context.service.js';
import { ApiError } from './api-error.js';
import { sanitizeResponse } from './sanitize.js';

/**
 * H-21 — request-scoped HTTP client.
 *
 * Reads the per-user JWT (if any) for the request in flight and
 * forwards it to the upstream API. The shared `EVER_WORKS_API_KEY` is
 * still used as a fallback when the request didn't carry a JWT (`hybrid`
 * or `shared-key` modes) and by the stdio transport, which has no HTTP
 * request at all. In `per-user-jwt` mode the shared key is null on the
 * config, so it is never sent — only the caller's JWT — and cross-tenant
 * access via a leaked platform key stays impossible.
 *
 * The caller's identity arrives via `CallerContextService`
 * (`AsyncLocalStorage`), NOT via the injected `REQUEST`. See that
 * service for why: the MCP transport binds its own adapter wrapper to
 * the `REQUEST` token, so `httpRequest.__callerJwt` was always
 * `undefined` and every data tool 401'd.
 */
@Injectable({ scope: Scope.REQUEST })
export class ApiClientService {
	constructor(
		@Inject(McpConfigService) private readonly config: McpConfigService,
		@Inject(CallerContextService) private readonly callerContext: CallerContextService,
		// Retained as a secondary source for any transport that binds the
		// real request object to REQUEST. Never the only channel — that is
		// exactly what broke.
		@Optional()
		@Inject(REQUEST)
		private readonly httpRequest: { __callerJwt?: string } | null = null
	) {}

	async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.config.apiUrl}${path}`;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		// H-21: forward the per-user JWT if present, fall back to shared key.
		// In `per-user-jwt` mode the shared key is null on the config, so
		// we never send it even if a JWT is missing — the upstream will reject.
		// A missing caller identity must stay a rejection: silently upgrading
		// it to the shared platform key would turn an auth bug into a
		// privilege-escalation bug.
		const callerJwt = this.callerContext.getCallerJwt() ?? this.httpRequest?.__callerJwt;
		if (callerJwt) {
			headers['Authorization'] = `Bearer ${callerJwt}`;
		} else if (this.config.apiKey) {
			headers['x-api-key'] = this.config.apiKey;
		}

		// Organization scope selection. Every whitelisted path is unprefixed,
		// so this header is the only way an upstream call can run under an
		// Organization (the API resolves it exactly as it does for the web
		// client, then authorises the caller against it). Absent = personal.
		if (this.config.scopeSlug) {
			headers['x-scope-slug'] = this.config.scopeSlug;
		}

		const init: RequestInit = {
			method,
			headers,
			signal: AbortSignal.timeout(30_000)
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
