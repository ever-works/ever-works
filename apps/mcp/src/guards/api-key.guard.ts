import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { McpConfigService } from '../config/mcp-config.service.js';

/**
 * H-21 — MCP auth, dual mode.
 *
 * Accepted credentials depend on `EVER_WORKS_MCP_AUTH_MODE`:
 *
 * | Mode             | Shared key          | Per-user JWT             |
 * |------------------|---------------------|--------------------------|
 * | shared-key       | required            | ignored                  |
 * | shared-key-jwt   | required            | required                 |
 * | per-user-jwt     | rejected if present | required                 |
 * | hybrid (default) | accepted            | accepted (preferred when present) |
 *
 * The caller's JWT (if present) is forwarded to the upstream API by
 * `ApiClientService` so per-user tenancy is restored. Headers:
 *
 * - `Authorization: Bearer <shared-key>` — the existing shared-key path.
 * - `x-ever-works-jwt: <user-jwt>` — the per-user JWT for the upstream API.
 *   Separated from `Authorization` so a single request can carry both.
 *
 * Constant-time compare on the shared key per H-08.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
	constructor(@Inject(McpConfigService) private readonly config: McpConfigService) {}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<{
			headers?: Record<string, string | string[] | undefined>;
			__callerJwt?: string;
		}>();
		const headers = request.headers ?? {};

		const sharedKeyHeader = singleHeader(headers['authorization']);
		const userJwtHeader = singleHeader(headers['x-ever-works-jwt']);

		const sharedKeyPresent = typeof sharedKeyHeader === 'string' && sharedKeyHeader.length > 0;
		const userJwtPresent = typeof userJwtHeader === 'string' && userJwtHeader.length > 0;

		// 1. Validate per-user JWT presence.
		if (this.config.requiresJwt() && !userJwtPresent) {
			throw new UnauthorizedException(
				`Per-user JWT required (x-ever-works-jwt header) for auth mode ${this.config.authMode}`
			);
		}

		// 2. Validate shared-key presence.
		const sharedKeyAllowed = this.config.allowsSharedKeyOnly() || this.config.authMode === 'shared-key-jwt';
		if (sharedKeyAllowed && this.config.apiKey) {
			// Either shared-key alone is OK (shared-key/hybrid) or it's
			// required alongside JWT (shared-key-jwt). In both cases, when
			// present, the value must be valid.
			if (!sharedKeyPresent && !userJwtPresent) {
				throw new UnauthorizedException('Missing credentials (Authorization Bearer or x-ever-works-jwt)');
			}
			if (sharedKeyPresent) {
				if (!sharedKeyMatches(sharedKeyHeader!, this.config.apiKey)) {
					throw new UnauthorizedException('Invalid shared API key');
				}
			} else if (this.config.authMode === 'shared-key-jwt') {
				throw new UnauthorizedException(
					'Shared API key required (Authorization Bearer) for auth mode shared-key-jwt'
				);
			}
		} else if (this.config.authMode === 'per-user-jwt' && sharedKeyPresent) {
			// In per-user-jwt mode, a shared key is not accepted — refuse to
			// silently honor it.
			throw new UnauthorizedException('Shared API key not accepted in auth mode per-user-jwt');
		} else if (this.config.authMode === 'shared-key' && !sharedKeyPresent) {
			throw new UnauthorizedException('Missing Authorization Bearer header');
		}

		// 3. Stash the per-user JWT (if any) on the request so ApiClientService
		// can forward it upstream. We do NOT verify the JWT here — that's the
		// upstream API's job. The MCP server is a transport.
		if (userJwtPresent) {
			request.__callerJwt = userJwtHeader as string;
		}

		return true;
	}
}

function singleHeader(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

function sharedKeyMatches(authHeader: string, apiKey: string): boolean {
	const expected = `Bearer ${apiKey}`;
	const expectedBuf = Buffer.from(expected, 'utf8');
	const providedBuf = Buffer.from(authHeader, 'utf8');
	const lengthsMatch = expectedBuf.length === providedBuf.length;
	const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
	const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);
	return lengthsMatch && bytesMatch;
}
