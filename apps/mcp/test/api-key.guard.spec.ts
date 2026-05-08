import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ApiKeyGuard } from '../src/guards/api-key.guard.js';

function buildContext(headers: { authorization?: string } | undefined): ExecutionContext {
	const request = headers === undefined ? {} : { headers };
	return {
		switchToHttp: () => ({
			getRequest: () => request,
			getResponse: () => ({}),
			getNext: () => undefined
		})
	} as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
	let guard: ApiKeyGuard;
	const ORIGINAL_KEY = process.env.EVER_WORKS_API_KEY;

	beforeEach(() => {
		guard = new ApiKeyGuard();
	});

	afterEach(() => {
		if (ORIGINAL_KEY === undefined) {
			delete process.env.EVER_WORKS_API_KEY;
		} else {
			process.env.EVER_WORKS_API_KEY = ORIGINAL_KEY;
		}
	});

	it('throws UnauthorizedException when EVER_WORKS_API_KEY is unset', () => {
		delete process.env.EVER_WORKS_API_KEY;
		const ctx = buildContext({ authorization: 'Bearer something' });
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws when EVER_WORKS_API_KEY is the empty string (falsy)', () => {
		process.env.EVER_WORKS_API_KEY = '';
		const ctx = buildContext({ authorization: 'Bearer ' });
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws when the Authorization header is missing', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext({});
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws when request.headers is undefined entirely', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext(undefined);
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws when the Authorization header does not match the Bearer template', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext({ authorization: 'Basic secret-key' });
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws when the Authorization header has the wrong key', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext({ authorization: 'Bearer wrong-key' });
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws on case-mismatched scheme ("bearer secret-key" — strict equality, not case-insensitive)', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext({ authorization: 'bearer secret-key' });
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('throws when the Bearer token has trailing whitespace', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext({ authorization: 'Bearer secret-key ' });
		expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
	});

	it('returns true when Authorization header exactly matches "Bearer <key>"', () => {
		process.env.EVER_WORKS_API_KEY = 'secret-key';
		const ctx = buildContext({ authorization: 'Bearer secret-key' });
		expect(guard.canActivate(ctx)).toBe(true);
	});
});
