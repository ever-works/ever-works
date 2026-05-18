import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ApiKeyGuard } from '../src/guards/api-key.guard.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';

function buildContext(headers: Record<string, string | string[]> | undefined): ExecutionContext {
	const request = headers === undefined ? {} : { headers };
	return {
		switchToHttp: () => ({
			getRequest: () => request,
			getResponse: () => ({}),
			getNext: () => undefined
		})
	} as unknown as ExecutionContext;
}

// H-21 — ApiKeyGuard now reads from McpConfigService (which itself parses
// EVER_WORKS_MCP_AUTH_MODE + EVER_WORKS_API_KEY at construction time).
// Build a guard against a freshly-constructed config so each test gets the
// env it expects.
function buildGuard(): ApiKeyGuard {
	const config = new McpConfigService();
	return new ApiKeyGuard(config);
}

describe('ApiKeyGuard (H-08 constant-time + H-21 dual mode)', () => {
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		// Reset to a deterministic baseline so each test sets exactly what it needs.
		// Tests that intentionally omit EVER_WORKS_API_KEY override via `delete`
		// or `''` below.
		process.env = {
			...ORIGINAL_ENV,
			EVER_WORKS_API_KEY: 'secret-key',
			EVER_WORKS_MCP_AUTH_MODE: 'shared-key',
			NODE_ENV: 'test'
		};
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	describe('shared-key mode (legacy)', () => {
		it('throws when McpConfig refuses to construct because EVER_WORKS_API_KEY is unset', () => {
			delete process.env.EVER_WORKS_API_KEY;
			expect(() => buildGuard()).toThrow(/EVER_WORKS_API_KEY is required/);
		});

		it('throws UnauthorizedException when the Authorization header is missing', () => {
			const guard = buildGuard();
			expect(() => guard.canActivate(buildContext({}))).toThrow(UnauthorizedException);
		});

		it('throws when request.headers is undefined entirely', () => {
			const guard = buildGuard();
			expect(() => guard.canActivate(buildContext(undefined))).toThrow(UnauthorizedException);
		});

		it('throws when the Authorization header does not match the Bearer template', () => {
			const guard = buildGuard();
			const ctx = buildContext({ authorization: 'Basic secret-key' });
			expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
		});

		it('throws when the Authorization header has the wrong key', () => {
			const guard = buildGuard();
			const ctx = buildContext({ authorization: 'Bearer wrong-key' });
			expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
		});

		it('throws on case-mismatched scheme (strict equality, not case-insensitive)', () => {
			const guard = buildGuard();
			const ctx = buildContext({ authorization: 'bearer secret-key' });
			expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
		});

		it('throws when the Bearer token has trailing whitespace (constant-time compare is byte-exact)', () => {
			const guard = buildGuard();
			const ctx = buildContext({ authorization: 'Bearer secret-key ' });
			expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
		});

		it('returns true when Authorization header exactly matches "Bearer <key>"', () => {
			const guard = buildGuard();
			const ctx = buildContext({ authorization: 'Bearer secret-key' });
			expect(guard.canActivate(ctx)).toBe(true);
		});

		it('rejects a JWT-only request (no Authorization header) — the shared key is part of the contract in shared-key mode', () => {
			const guard = buildGuard();
			const ctx = buildContext({ 'x-ever-works-jwt': 'user-jwt-abc' });
			expect(() => guard.canActivate(ctx)).toThrow(
				/Shared API key required \(Authorization Bearer\) for auth mode shared-key/
			);
		});
	});

	describe('H-21 — per-user-jwt mode', () => {
		beforeEach(() => {
			process.env.EVER_WORKS_MCP_AUTH_MODE = 'per-user-jwt';
			// EVER_WORKS_API_KEY is optional in per-user-jwt mode.
			delete process.env.EVER_WORKS_API_KEY;
		});

		it('rejects requests with no JWT', () => {
			const guard = buildGuard();
			expect(() => guard.canActivate(buildContext({}))).toThrow(/Per-user JWT required/);
		});

		it('rejects a request that presents the legacy shared key', () => {
			process.env.EVER_WORKS_API_KEY = 'leaked-shared-key';
			const guard = buildGuard();
			const ctx = buildContext({
				authorization: 'Bearer leaked-shared-key',
				'x-ever-works-jwt': 'user-jwt-abc'
			});
			expect(() => guard.canActivate(ctx)).toThrow(/Shared API key not accepted/);
		});

		it('accepts a request with only the per-user JWT and stashes it on the request', () => {
			const guard = buildGuard();
			const headers = { 'x-ever-works-jwt': 'user-jwt-abc' };
			const request: { headers: typeof headers; __callerJwt?: string } = { headers };
			const ctx = {
				switchToHttp: () => ({
					getRequest: () => request,
					getResponse: () => ({}),
					getNext: () => undefined
				})
			} as unknown as ExecutionContext;
			expect(guard.canActivate(ctx)).toBe(true);
			expect(request.__callerJwt).toBe('user-jwt-abc');
		});
	});

	describe('H-21 — shared-key-jwt mode (both required)', () => {
		beforeEach(() => {
			process.env.EVER_WORKS_MCP_AUTH_MODE = 'shared-key-jwt';
		});

		it('rejects when only the shared key is present (JWT missing)', () => {
			const guard = buildGuard();
			expect(() => guard.canActivate(buildContext({ authorization: 'Bearer secret-key' }))).toThrow(
				/Per-user JWT required/
			);
		});

		it('accepts when BOTH shared key AND JWT are present', () => {
			const guard = buildGuard();
			const headers = {
				authorization: 'Bearer secret-key',
				'x-ever-works-jwt': 'user-jwt-abc'
			};
			const request: { headers: typeof headers; __callerJwt?: string } = { headers };
			const ctx = {
				switchToHttp: () => ({
					getRequest: () => request,
					getResponse: () => ({}),
					getNext: () => undefined
				})
			} as unknown as ExecutionContext;
			expect(guard.canActivate(ctx)).toBe(true);
			expect(request.__callerJwt).toBe('user-jwt-abc');
		});
	});

	describe('H-21 — hybrid mode (default; accept anything)', () => {
		beforeEach(() => {
			process.env.EVER_WORKS_MCP_AUTH_MODE = 'hybrid';
		});

		it('accepts a shared-key-only request', () => {
			const guard = buildGuard();
			expect(guard.canActivate(buildContext({ authorization: 'Bearer secret-key' }))).toBe(true);
		});

		it('accepts a JWT-only request', () => {
			const guard = buildGuard();
			const headers = { 'x-ever-works-jwt': 'user-jwt-abc' };
			const request: { headers: typeof headers; __callerJwt?: string } = { headers };
			const ctx = {
				switchToHttp: () => ({
					getRequest: () => request,
					getResponse: () => ({}),
					getNext: () => undefined
				})
			} as unknown as ExecutionContext;
			expect(guard.canActivate(ctx)).toBe(true);
			expect(request.__callerJwt).toBe('user-jwt-abc');
		});

		it('rejects when neither credential is present', () => {
			const guard = buildGuard();
			expect(() => guard.canActivate(buildContext({}))).toThrow(UnauthorizedException);
		});
	});
});
