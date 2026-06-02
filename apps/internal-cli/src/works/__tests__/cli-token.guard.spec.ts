import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { CliTokenGuard } from '../cli-token.guard';

function ctxWithHeaders(headers: Record<string, string | string[] | undefined>): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ headers }) as unknown,
        }),
    } as unknown as ExecutionContext;
}

const TOKEN = 'a'.repeat(64); // shape of randomBytes(32).toString('hex')

describe('CliTokenGuard', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('accepts a matching Authorization Bearer token', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ authorization: `Bearer ${TOKEN}` });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('accepts a matching X-EW-CLI-Token header', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ 'x-ew-cli-token': TOKEN });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('rejects an unauthenticated request (no credentials) — the attack the fix closes', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({});
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when the Bearer token does not match', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ authorization: 'Bearer wrong-token' });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects when the X-EW-CLI-Token header does not match', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ 'x-ew-cli-token': 'b'.repeat(64) });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a non-Bearer Authorization scheme', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ authorization: 'Basic dXNlcjpwYXNz' });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a same-length-but-different-bytes token (constant-time path)', () => {
        const guard = new CliTokenGuard(TOKEN);
        const same = 'X'.repeat(TOKEN.length);
        const ctx = ctxWithHeaders({ authorization: `Bearer ${same}` });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a different-length token without leaking via length short-circuit', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ authorization: 'Bearer short' });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('fails closed when constructed without a token', () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const guard = new CliTokenGuard('');
        const ctx = ctxWithHeaders({ authorization: `Bearer ${TOKEN}` });
        expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('prefers the X-EW-CLI-Token header over Authorization when both are present', () => {
        const guard = new CliTokenGuard(TOKEN);
        // Valid CLI-token header, garbage Authorization → still accepted.
        const ctx = ctxWithHeaders({
            'x-ew-cli-token': TOKEN,
            authorization: 'Bearer not-the-token',
        });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it('takes the first value when a header arrives as an array', () => {
        const guard = new CliTokenGuard(TOKEN);
        const ctx = ctxWithHeaders({ 'x-ew-cli-token': [TOKEN, 'second'] });
        expect(guard.canActivate(ctx)).toBe(true);
    });
});
