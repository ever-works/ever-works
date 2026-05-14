import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { PlatformSecretGuard } from './platform-secret.guard';

function ctxWithHeader(authorization?: string): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ headers: { authorization } }) as unknown,
        }),
    } as unknown as ExecutionContext;
}

describe('PlatformSecretGuard', () => {
    let guard: PlatformSecretGuard;
    const originalToken = process.env.PLATFORM_API_SECRET_TOKEN;

    beforeEach(() => {
        guard = new PlatformSecretGuard();
        process.env.PLATFORM_API_SECRET_TOKEN = 'platform-shared-secret-value-32x';
    });

    afterAll(() => {
        process.env.PLATFORM_API_SECRET_TOKEN = originalToken;
    });

    it('accepts a matching bearer token', () => {
        const ctx = ctxWithHeader('Bearer platform-shared-secret-value-32x');
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('rejects when the bearer token does not match', () => {
        const ctx = ctxWithHeader('Bearer wrong-token');
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when the header is missing', () => {
        const ctx = ctxWithHeader();
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when the header is not a bearer token', () => {
        const ctx = ctxWithHeader('Basic dXNlcjpwYXNz');
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws ServiceUnavailable when the platform token env var is missing', () => {
        delete process.env.PLATFORM_API_SECRET_TOKEN;
        const ctx = ctxWithHeader('Bearer anything');
        expect(() => guard.canActivate(ctx)).toThrow(ServiceUnavailableException);
    });

    it('rejects when provided token has the same length but different bytes (constant-time)', () => {
        // Same length as the expected token, but every byte different.
        const same = 'X'.repeat('platform-shared-secret-value-32x'.length);
        const ctx = ctxWithHeader(`Bearer ${same}`);
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when provided token has a different length', () => {
        const ctx = ctxWithHeader('Bearer short');
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
});
