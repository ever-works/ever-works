jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
}));

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ModuleRef, Reflector } from '@nestjs/core';
import { AuthSessionGuard } from './auth-session.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { UserRepository } from '@ever-works/agent/database';

type ApiKeyServiceMock = jest.Mocked<Pick<ApiKeyService, 'validateKey'>>;
type UserRepositoryMock = jest.Mocked<Pick<UserRepository, 'findById'>>;

function createContext(
    request: any,
    handler = () => undefined,
    klass = class {},
): ExecutionContext {
    return {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => klass,
    } as unknown as ExecutionContext;
}

function createGuard(opts?: { providerUser?: any; providerError?: Error }) {
    const reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>> = {
        getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as any;

    const apiKeyService: ApiKeyServiceMock = { validateKey: jest.fn() } as any;
    const userRepository: UserRepositoryMock = { findById: jest.fn() } as any;

    const moduleRef: jest.Mocked<Pick<ModuleRef, 'get'>> = {
        get: jest.fn((token: any) => {
            if (token === ApiKeyService) return apiKeyService;
            if (token === UserRepository) return userRepository;
            throw new Error(`Unexpected token: ${String(token)}`);
        }),
    } as any;

    const authProvider = {
        authenticate: jest.fn(async () =>
            opts?.providerError ? Promise.reject(opts.providerError) : (opts?.providerUser ?? null),
        ),
    };
    if (opts?.providerError) {
        authProvider.authenticate = jest.fn(async () => {
            throw opts.providerError!;
        });
    } else if (opts?.providerUser !== undefined) {
        authProvider.authenticate = jest.fn().mockResolvedValue(opts.providerUser);
    } else {
        authProvider.authenticate = jest.fn().mockResolvedValue(null);
    }

    const guard = new AuthSessionGuard(reflector as any, moduleRef as any, authProvider as any);
    return { guard, reflector, apiKeyService, userRepository, moduleRef, authProvider };
}

describe('AuthSessionGuard', () => {
    describe('public-route short-circuit', () => {
        it('returns true without inspecting headers when handler is @Public()', async () => {
            const { guard, reflector, apiKeyService, authProvider } = createGuard();
            (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);

            const result = await guard.canActivate(createContext({ headers: {} }));

            expect(result).toBe(true);
            expect(apiKeyService.validateKey).not.toHaveBeenCalled();
            expect(authProvider.authenticate).not.toHaveBeenCalled();
        });

        it('checks both handler and class metadata via getAllAndOverride', async () => {
            const { guard, reflector } = createGuard({ providerUser: { userId: 'u1' } });
            (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);

            const handler = () => undefined;
            class Ctrl {}
            await guard.canActivate(createContext({ headers: {} }, handler, Ctrl));

            expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
                handler,
                Ctrl,
            ]);
        });
    });

    describe('API-key path via x-api-key header', () => {
        it('accepts ew_live_-prefixed key and resolves user', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1', id: 'k1' } as any);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'a',
                registrationProvider: 'email',
                emailVerified: true,
                isActive: true,
                avatar: 'av',
            } as any);

            const req: any = { headers: { 'x-api-key': 'ew_live_abc' } };
            const result = await guard.canActivate(createContext(req));

            expect(result).toBe(true);
            expect(apiKeyService.validateKey).toHaveBeenCalledWith('ew_live_abc');
            expect(userRepository.findById).toHaveBeenCalledWith('u1');
            expect(req.user).toEqual({
                userId: 'u1',
                email: 'a@b.co',
                username: 'a',
                provider: 'email',
                emailVerified: true,
                isActive: true,
                avatar: 'av',
                iat: expect.any(Number),
                iss: 'ever-works',
                aud: 'ever-works',
            });
        });

        it('coerces falsy avatar to null', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'a',
                registrationProvider: 'email',
                emailVerified: true,
                isActive: true,
                avatar: '',
            } as any);

            const req: any = { headers: { 'x-api-key': 'ew_live_abc' } };
            await guard.canActivate(createContext(req));

            expect(req.user.avatar).toBeNull();
        });

        it('preserves a truthy avatar URL', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'a',
                registrationProvider: 'email',
                emailVerified: true,
                isActive: true,
                avatar: 'https://x/y.png',
            } as any);

            const req: any = { headers: { 'x-api-key': 'ew_live_abc' } };
            await guard.canActivate(createContext(req));

            expect(req.user.avatar).toBe('https://x/y.png');
        });

        it('throws Unauthorized for invalid key', async () => {
            const { guard, apiKeyService } = createGuard();
            apiKeyService.validateKey.mockResolvedValue(null as any);

            await expect(
                guard.canActivate(createContext({ headers: { 'x-api-key': 'ew_live_xxx' } })),
            ).rejects.toThrow(new UnauthorizedException('Invalid or expired API key'));
        });

        it('throws Unauthorized when user is missing', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue(null as any);

            await expect(
                guard.canActivate(createContext({ headers: { 'x-api-key': 'ew_live_xxx' } })),
            ).rejects.toThrow(new UnauthorizedException('User account is inactive'));
        });

        it('throws Unauthorized when user is inactive', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: false } as any);

            await expect(
                guard.canActivate(createContext({ headers: { 'x-api-key': 'ew_live_xxx' } })),
            ).rejects.toThrow(new UnauthorizedException('User account is inactive'));
        });

        it('lazy-resolves ApiKeyService and UserRepository through ModuleRef on first use', async () => {
            const { guard, moduleRef, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: true } as any);

            await guard.canActivate(createContext({ headers: { 'x-api-key': 'ew_live_a' } }));
            expect(moduleRef.get).toHaveBeenCalledWith(ApiKeyService, { strict: false });
            expect(moduleRef.get).toHaveBeenCalledWith(UserRepository, { strict: false });

            // Second invocation must not re-resolve.
            (moduleRef.get as jest.Mock).mockClear();
            await guard.canActivate(createContext({ headers: { 'x-api-key': 'ew_live_b' } }));
            expect(moduleRef.get).not.toHaveBeenCalled();
        });

        it('does NOT treat non-string x-api-key as API key', async () => {
            const { guard, apiKeyService, authProvider } = createGuard({
                providerUser: { userId: 'u1', iss: 'auth-runtime' },
            });
            apiKeyService.validateKey.mockResolvedValue(null as any);

            const req: any = { headers: { 'x-api-key': ['ew_live_a', 'ew_live_b'] } };
            await guard.canActivate(createContext(req));

            expect(apiKeyService.validateKey).not.toHaveBeenCalled();
            expect(authProvider.authenticate).toHaveBeenCalled();
        });

        it('does NOT treat non-prefixed x-api-key value as API key', async () => {
            const { guard, apiKeyService, authProvider } = createGuard({
                providerUser: { userId: 'u1', iss: 'auth-runtime' },
            });

            const req: any = { headers: { 'x-api-key': 'sk-foo' } };
            await guard.canActivate(createContext(req));

            expect(apiKeyService.validateKey).not.toHaveBeenCalled();
            expect(authProvider.authenticate).toHaveBeenCalled();
        });
    });

    describe('API-key path via Authorization: Bearer', () => {
        it('accepts Bearer token starting with ew_live_', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: true } as any);

            const req: any = { headers: { authorization: 'Bearer ew_live_xyz' } };
            await guard.canActivate(createContext(req));

            expect(apiKeyService.validateKey).toHaveBeenCalledWith('ew_live_xyz');
        });

        it('falls through to provider when Bearer token is NOT ew_live_', async () => {
            const { guard, apiKeyService, authProvider } = createGuard({
                providerUser: { userId: 'u1', iss: 'auth-runtime' },
            });

            const req: any = { headers: { authorization: 'Bearer some-jwt-token' } };
            await guard.canActivate(createContext(req));

            expect(apiKeyService.validateKey).not.toHaveBeenCalled();
            expect(authProvider.authenticate).toHaveBeenCalled();
        });

        it('falls through to provider when scheme is not Bearer (case-sensitive)', async () => {
            const { guard, apiKeyService, authProvider } = createGuard({
                providerUser: { userId: 'u1', iss: 'auth-runtime' },
            });

            const req: any = { headers: { authorization: 'bearer ew_live_xyz' } };
            await guard.canActivate(createContext(req));

            expect(apiKeyService.validateKey).not.toHaveBeenCalled();
            expect(authProvider.authenticate).toHaveBeenCalled();
        });

        it('prefers x-api-key over Authorization when both are set', async () => {
            const { guard, apiKeyService, userRepository } = createGuard();
            apiKeyService.validateKey.mockResolvedValue({ userId: 'u1' } as any);
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: true } as any);

            const req: any = {
                headers: {
                    'x-api-key': 'ew_live_via_header',
                    authorization: 'Bearer ew_live_via_bearer',
                },
            };
            await guard.canActivate(createContext(req));

            expect(apiKeyService.validateKey).toHaveBeenCalledWith('ew_live_via_header');
        });
    });

    describe('AuthProvider fallback', () => {
        it('returns true and attaches provider user when authenticate resolves a user', async () => {
            const providerUser = { userId: 'u1', iss: 'auth-runtime' };
            const { guard, authProvider } = createGuard({ providerUser });

            const req: any = { headers: { cookie: 'session=abc' } };
            const result = await guard.canActivate(createContext(req));

            expect(result).toBe(true);
            expect(req.user).toBe(providerUser);
            expect(authProvider.authenticate).toHaveBeenCalled();
            // The Headers object passed to authenticate should carry the cookie value.
            const headers = (authProvider.authenticate as jest.Mock).mock.calls[0][0] as Headers;
            expect(headers.get('cookie')).toBe('session=abc');
        });

        it('throws Unauthorized when provider returns null (no session cookie)', async () => {
            const { guard } = createGuard({ providerUser: null });

            await expect(guard.canActivate(createContext({ headers: {} }))).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('treats missing request.headers as empty (defends against odd HTTP frameworks)', async () => {
            const { guard, authProvider } = createGuard({
                providerUser: { userId: 'u1', iss: 'auth-runtime' },
            });

            const req: any = {}; // no headers at all
            await guard.canActivate(createContext(req));

            expect(authProvider.authenticate).toHaveBeenCalled();
        });

        it('propagates errors thrown by the auth provider', async () => {
            const boom = new Error('better-auth blew up');
            const { guard } = createGuard({ providerError: boom });

            await expect(guard.canActivate(createContext({ headers: {} }))).rejects.toThrow(boom);
        });
    });
});
