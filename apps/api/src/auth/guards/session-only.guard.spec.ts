import type { ExecutionContext } from '@nestjs/common';
import { EverIdHttpException } from '../services/ever-id-errors';
import { SessionOnlyGuard } from './session-only.guard';

/** APW-12 (Ever ID) — S27 / ACC-12-21: only a person's session may change connected identities. */
function context(user: unknown): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
}

describe('SessionOnlyGuard', () => {
    it('admits a session', () => {
        expect(
            new SessionOnlyGuard().canActivate(context({ userId: 'u', authMethod: 'session' })),
        ).toBe(true);
    });

    it.each([
        ['an API key', { userId: 'u', authMethod: 'api-key' }],
        ['a delegated token', { userId: 'u', authMethod: 'ever-id-delegated' }],
        ['a principal without a stamp', { userId: 'u' }],
        ['no principal', undefined],
    ])('refuses %s with 403 session_required', (_label, user) => {
        let thrown: unknown;
        try {
            new SessionOnlyGuard().canActivate(context(user));
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(EverIdHttpException);
        expect((thrown as EverIdHttpException).getStatus()).toBe(403);
        expect((thrown as EverIdHttpException).getResponse()).toMatchObject({
            status: 'error',
            code: 'session_required',
        });
    });
});
