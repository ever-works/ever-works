jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/fleet', () => ({
    FleetRunCredentialService: class FleetRunCredentialService {},
}));

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ModuleRef, Reflector } from '@nestjs/core';
import { AuthSessionGuard } from './auth-session.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
    DELEGATED_READ_ORIGINS,
    DELEGATED_READ_SCOPE,
} from '../decorators/delegated-read.decorator';
import { NO_TOKEN_IN_QUERY } from './no-token-in-query.guard';
import { EVER_ID_DELEGATION_VERIFIER, EVER_ID_SIGNED_OUT_PROBE } from './ever-id-guard.tokens';
import { EverIdHttpException } from '../services/ever-id-errors';
import { DelegatedReadOriginRefusedException } from './delegated-read-origin';

/**
 * APW-12 (Ever ID) — the three additive branches of `AuthSessionGuard` (plan
 * §5.3, §5.4, FR-17): the query-token refusal that runs before anything else,
 * the delegated read admitted ONLY on `@DelegatedRead(scope)` handlers, and the
 * "signed out by Ever ID" answer. The pre-existing behaviour is pinned,
 * unchanged, by `auth-session.guard.spec.ts`.
 */
const JWT = 'aaaa.bbbb.cccc';

function createContext(request: any): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => function handler() {},
        getClass: () => class Ctrl {},
    } as unknown as ExecutionContext;
}

function createGuard(options: {
    metadata?: Record<string, unknown>;
    providerUser?: unknown;
    delegation?: { authenticate: jest.Mock } | null;
    signedOut?: boolean;
}) {
    const reflector = {
        getAllAndOverride: jest.fn((key: string) => options.metadata?.[key]),
    } as unknown as jest.Mocked<Reflector>;
    const delegation =
        options.delegation === undefined ? { authenticate: jest.fn() } : options.delegation;
    const probe = { wasSignedOut: jest.fn(async () => options.signedOut === true) };
    const moduleRef = {
        get: jest.fn((token: unknown) => {
            if (token === EVER_ID_DELEGATION_VERIFIER && delegation) return delegation;
            if (token === EVER_ID_SIGNED_OUT_PROBE) return probe;
            throw new Error(`Unexpected token: ${String(token)}`);
        }),
    } as unknown as jest.Mocked<ModuleRef>;
    const authProvider = {
        authenticate: jest.fn().mockResolvedValue(options.providerUser ?? null),
    };
    const guard = new AuthSessionGuard(reflector, moduleRef, authProvider as never);
    return { guard, delegation, probe, authProvider };
}

describe('AuthSessionGuard — Ever ID branches', () => {
    describe('token in the query string (FR-17)', () => {
        it('answers 400 on an Ever ID path before the public short-circuit', async () => {
            const { guard, authProvider } = createGuard({ metadata: { [IS_PUBLIC_KEY]: true } });

            await expect(
                guard.canActivate(
                    createContext({
                        originalUrl: '/api/auth/ever-id/callback?logout_token=x',
                        query: { logout_token: 'x' },
                        headers: {},
                    }),
                ),
            ).rejects.toBeInstanceOf(EverIdHttpException);
            expect(authProvider.authenticate).not.toHaveBeenCalled();
        });

        it('answers 400 on a handler that opted in, wherever it lives', async () => {
            const { guard } = createGuard({ metadata: { [NO_TOKEN_IN_QUERY]: true } });

            await expect(
                guard.canActivate(
                    createContext({
                        url: '/api/me/apps?access_token=x',
                        query: { access_token: 'x' },
                    }),
                ),
            ).rejects.toMatchObject({ response: { code: 'token_in_query' } });
        });

        it('leaves every other route untouched', async () => {
            const { guard } = createGuard({ metadata: { [IS_PUBLIC_KEY]: true } });

            await expect(
                guard.canActivate(
                    createContext({
                        url: '/api/works?token=x',
                        query: { token: 'x' },
                        headers: {},
                    }),
                ),
            ).resolves.toBe(true);
        });
    });

    describe('delegated read (FR-44..FR-47)', () => {
        it('admits a JWT on a @DelegatedRead handler and stamps ever-id-delegated', async () => {
            const principal = {
                user: { userId: 'u1', authMethod: 'ever-id-delegated' },
                binding: { identityId: 'i1', clientId: 'c1', scopes: ['apps:read'] },
            };
            const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
            const { guard, authProvider } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                delegation,
            });
            const request: any = { headers: { authorization: `Bearer ${JWT}` }, ip: '203.0.113.7' };

            await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

            expect(delegation.authenticate).toHaveBeenCalledWith(JWT, 'apps:read', {
                ipAddress: '203.0.113.7',
                userAgent: null,
            });
            expect(request.user).toEqual(principal.user);
            expect(request.everIdDelegation).toEqual(principal.binding);
            expect(authProvider.authenticate).not.toHaveBeenCalled();
        });

        it('answers the plain 401 for any refusal, and never falls back to the session path', async () => {
            const delegation = { authenticate: jest.fn().mockResolvedValue(null) };
            const { guard, authProvider } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                delegation,
            });

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(authProvider.authenticate).not.toHaveBeenCalled();
        });

        it('propagates 403 insufficient_scope from the verifier', async () => {
            const refusal = new EverIdHttpException('insufficientScope');
            const delegation = { authenticate: jest.fn().mockRejectedValue(refusal) };
            const { guard } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                delegation,
            });

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).rejects.toBe(refusal);
        });

        it('never consults the verifier without the metadata — a JWT is refused exactly as before (FR-46)', async () => {
            const { guard, delegation } = createGuard({});

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(delegation!.authenticate).not.toHaveBeenCalled();
        });

        it('never consults the verifier for a session bearer (no dot) on a marked handler', async () => {
            const user = { userId: 'u1', iss: 'auth-runtime' };
            const { guard, delegation } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                providerUser: user,
            });
            const request: any = { headers: { authorization: 'Bearer opaque-session-token' } };

            await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
            expect(delegation!.authenticate).not.toHaveBeenCalled();
            expect(request.user.authMethod).toBe('session');
        });

        it('answers 401 when no verifier is bound', async () => {
            const { guard } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                delegation: null,
            });

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });
    });

    describe('where a delegated read may come from (APW-11 FR-50, ACC-11-38)', () => {
        const ALLOWED = 'https://app-stage.ever.co';
        const metadata = {
            [DELEGATED_READ_SCOPE]: 'apps:read',
            [DELEGATED_READ_ORIGINS]: () => [ALLOWED],
        };
        const principal = {
            user: { userId: 'u1', authMethod: 'ever-id-delegated' },
            binding: { identityId: 'i1', clientId: 'c1', scopes: ['apps:read'] },
        };

        it('refuses an unlisted origin with 403 origin_not_allowed before the token is read', async () => {
            const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
            const { guard, authProvider } = createGuard({ metadata, delegation });

            const refusal = guard.canActivate(
                createContext({
                    headers: { authorization: `Bearer ${JWT}`, origin: 'https://unlisted.example' },
                }),
            );

            await expect(refusal).rejects.toBeInstanceOf(DelegatedReadOriginRefusedException);
            await expect(refusal).rejects.toMatchObject({
                status: 403,
                response: { status: 'error', code: 'origin_not_allowed' },
            });
            expect(delegation.authenticate).not.toHaveBeenCalled();
            expect(authProvider.authenticate).not.toHaveBeenCalled();
        });

        it('refuses a delegated call that carries no Origin at all', async () => {
            const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
            const { guard } = createGuard({ metadata, delegation });

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).rejects.toMatchObject({ status: 403, response: { code: 'origin_not_allowed' } });
            expect(delegation.authenticate).not.toHaveBeenCalled();
        });

        it('compares exactly: a longer host, another scheme and the opaque origin are refused', async () => {
            for (const origin of [
                `${ALLOWED}.attacker.example`,
                'http://app-stage.ever.co',
                'null',
                `${ALLOWED}/`,
            ]) {
                const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
                const { guard } = createGuard({ metadata, delegation });
                await expect(
                    guard.canActivate(
                        createContext({ headers: { authorization: `Bearer ${JWT}`, origin } }),
                    ),
                ).rejects.toBeInstanceOf(DelegatedReadOriginRefusedException);
                expect(delegation.authenticate).not.toHaveBeenCalled();
            }
        });

        it('verifies the token from a listed origin, exactly as before', async () => {
            const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
            const { guard } = createGuard({ metadata, delegation });
            const request: any = { headers: { authorization: `Bearer ${JWT}`, origin: ALLOWED } };

            await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
            expect(delegation.authenticate).toHaveBeenCalledTimes(1);
            expect(request.user).toEqual(principal.user);
        });

        it('fails closed when the list cannot be read', async () => {
            const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
            const { guard } = createGuard({
                metadata: {
                    [DELEGATED_READ_SCOPE]: 'apps:read',
                    [DELEGATED_READ_ORIGINS]: () => {
                        throw new Error('unreadable');
                    },
                },
                delegation,
            });

            await expect(
                guard.canActivate(
                    createContext({ headers: { authorization: `Bearer ${JWT}`, origin: ALLOWED } }),
                ),
            ).rejects.toBeInstanceOf(DelegatedReadOriginRefusedException);
            expect(delegation.authenticate).not.toHaveBeenCalled();
        });

        it('never applies to a session bearer, from any origin or none', async () => {
            const user = { userId: 'u1', iss: 'auth-runtime' };
            for (const origin of [undefined, 'https://unlisted.example']) {
                const { guard, delegation } = createGuard({ metadata, providerUser: user });
                const headers: Record<string, string> = { authorization: 'Bearer opaque-session' };
                if (origin) headers.origin = origin;
                const request: any = { headers };

                await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
                expect(request.user.authMethod).toBe('session');
                expect(delegation!.authenticate).not.toHaveBeenCalled();
            }
        });

        it('leaves a handler without the origin rule as it was: no Origin needed', async () => {
            const delegation = { authenticate: jest.fn().mockResolvedValue(principal) };
            const { guard } = createGuard({
                metadata: { [DELEGATED_READ_SCOPE]: 'apps:read' },
                delegation,
            });

            await expect(
                guard.canActivate(createContext({ headers: { authorization: `Bearer ${JWT}` } })),
            ).resolves.toBe(true);
            expect(delegation.authenticate).toHaveBeenCalledTimes(1);
        });
    });

    describe('signed out by Ever ID (S6)', () => {
        it('answers 401 ever_id_signed_out for a bearer a sign-out notice ended', async () => {
            const { guard, probe } = createGuard({ signedOut: true });

            await expect(
                guard.canActivate(
                    createContext({ headers: { authorization: 'Bearer ended-session' } }),
                ),
            ).rejects.toMatchObject({ response: { code: 'ever_id_signed_out' }, status: 401 });
            expect(probe.wasSignedOut).toHaveBeenCalledWith('ended-session');
        });

        it('keeps the plain 401 otherwise, and for machine credentials never asks', async () => {
            const { guard, probe } = createGuard({ signedOut: false });

            await expect(
                guard.canActivate(
                    createContext({ headers: { authorization: 'Bearer expired-session' } }),
                ),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            await expect(guard.canActivate(createContext({ headers: {} }))).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
            expect(probe.wasSignedOut).toHaveBeenCalledTimes(1);
        });
    });
});
