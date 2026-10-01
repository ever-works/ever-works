import type { ExecutionContext } from '@nestjs/common';
import { EverIdHttpException } from '../services/ever-id-errors';
import { NoTokenInQueryGuard, hasTokenInQuery, isEverIdPath } from './no-token-in-query.guard';

/** APW-12 (Ever ID) — FR-17 / S19 / ACC-12-10: a token in the query string is refused with 400. */
function context(request: Record<string, unknown>): ExecutionContext {
    return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('NoTokenInQueryGuard', () => {
    it.each([
        'access_token',
        'id_token',
        'logout_token',
        'token',
        'sessionToken',
        'code_verifier',
        'ACCESS_TOKEN',
    ])('refuses `%s` in the query with 400 token_in_query', (key) => {
        const guard = new NoTokenInQueryGuard();
        let thrown: unknown;
        try {
            guard.canActivate(context({ query: { [key]: 'value' } }));
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(EverIdHttpException);
        expect((thrown as EverIdHttpException).getStatus()).toBe(400);
        expect((thrown as EverIdHttpException).getResponse()).toMatchObject({
            code: 'token_in_query',
        });
        // The value is never echoed.
        expect(JSON.stringify((thrown as EverIdHttpException).getResponse())).not.toContain(
            'value',
        );
    });

    it('lets every other query through', () => {
        expect(
            new NoTokenInQueryGuard().canActivate(
                context({ query: { returnTo: '/x', state: 's' } }),
            ),
        ).toBe(true);
        expect(new NoTokenInQueryGuard().canActivate(context({}))).toBe(true);
    });

    it('reads the raw URL when no parsed query exists', () => {
        expect(hasTokenInQuery({ url: '/api/auth/ever-id/session?id_token=abc' })).toBe(true);
        expect(hasTokenInQuery({ url: '/api/auth/ever-id/session?returnTo=/x' })).toBe(false);
    });

    it('recognises Ever ID paths only', () => {
        expect(isEverIdPath({ originalUrl: '/api/auth/ever-id/authorize?x=1' })).toBe(true);
        expect(isEverIdPath({ url: '/api/auth/ever-id' })).toBe(true);
        expect(isEverIdPath({ url: '/api/auth/login' })).toBe(false);
        expect(isEverIdPath({ url: '/api/auth/ever-identity' })).toBe(false);
    });
});
