jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
}));

// Self-build slice Z (EW-796): the guard resolves `FleetRunCredentialService`
// lazily through `moduleRef`, so only its identity matters here. Stubbing
// the module keeps this unit spec from dragging in the agent fleet runtime
// (TypeORM entities, the event bus) for one token-prefix branch.
jest.mock('@ever-works/agent/fleet', () => ({
    FleetRunCredentialService: class FleetRunCredentialService {},
}));

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ModuleRef, Reflector } from '@nestjs/core';
import { AuthSessionGuard } from './auth-session.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { UserRepository } from '@ever-works/agent/database';
import { FleetRunCredentialService } from '@ever-works/agent/fleet';

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

function createGuard(opts?: {
    providerUser?: any;
    providerError?: Error;
    noFleetModule?: boolean;
}) {
    const reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>> = {
        getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as any;

    const apiKeyService: ApiKeyServiceMock = { validateKey: jest.fn() } as any;
    const userRepository: UserRepositoryMock = { findById: jest.fn() } as any;
    const runCredentials = { authenticate: jest.fn() };

    const moduleRef: jest.Mocked<Pick<ModuleRef, 'get'>> = {
        get: jest.fn((token: any) => {
            if (token === ApiKeyService) return apiKeyService;
            if (token === UserRepository) return userRepository;
            if (token === FleetRunCredentialService) {
                if (opts?.noFleetModule) throw new Error('FleetRunCredentialService is not bound');
                return runCredentials;
            }
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
    return {
        guard,
        reflector,
        apiKeyService,
        userRepository,
        runCredentials,
        moduleRef,
        authProvider,
    };
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

/**
 * Self-build slice Z (EW-796) — the `ew_run_` fleet-run credential path.
 *
 * What has to hold:
 *   - a run token authenticates as the OWNER, so every ownership check
 *     downstream is the one it always was;
 *   - the run binding lands on the request for `SessionScopeGuard`;
 *   - it is validated by the RUN validator, never by `ApiKeyService`;
 *   - every refusal is the SAME 401 as a bad personal key, so a model
 *     holding its own token cannot map the surface it is refused from;
 *   - a bearer that is neither prefix still falls through to the auth
 *     provider, exactly as before this slice.
 */
describe('AuthSessionGuard — fleet-run credential (ew_run_)', () => {
    const RUN_TOKEN = 'ew_run_0123456789abcdef0123456789abcdef';
    const activeUser = {
        id: 'owner-1',
        email: 'owner@example.com',
        username: 'owner',
        registrationProvider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
    };
    const binding = {
        keyId: 'key-1',
        userId: 'owner-1',
        jobId: 'job-1',
        nodeId: 'node-1',
        runId: 'run-1',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        expiresAt: new Date(Date.now() + 60_000),
    };

    function request(over: Record<string, unknown> = {}) {
        return {
            method: 'GET',
            path: '/api/tasks',
            headers: { authorization: `Bearer ${RUN_TOKEN}` },
            ...over,
        } as any;
    }

    it('authenticates as the owner and stashes the run binding', async () => {
        const { guard, runCredentials, userRepository } = createGuard();
        runCredentials.authenticate.mockResolvedValue(binding);
        (userRepository.findById as jest.Mock).mockResolvedValue(activeUser);
        const req = request();

        await expect(guard.canActivate(createContext(req))).resolves.toBe(true);

        expect(req.user).toMatchObject({ userId: 'owner-1', email: 'owner@example.com' });
        expect(req.fleetRunCredential).toEqual({
            jobId: 'job-1',
            nodeId: 'node-1',
            runId: 'run-1',
            organizationId: 'org-1',
        });
    });

    it('passes the method and path so the route allowlist can be applied', async () => {
        const { guard, runCredentials, userRepository } = createGuard();
        runCredentials.authenticate.mockResolvedValue(binding);
        (userRepository.findById as jest.Mock).mockResolvedValue(activeUser);

        await guard.canActivate(
            createContext(request({ method: 'POST', path: '/api/tasks/t1/chat' })),
        );

        expect(runCredentials.authenticate).toHaveBeenCalledWith(RUN_TOKEN, {
            method: 'POST',
            path: '/api/tasks/t1/chat',
        });
    });

    it('never asks ApiKeyService to validate a run token', async () => {
        const { guard, runCredentials, apiKeyService, userRepository } = createGuard();
        runCredentials.authenticate.mockResolvedValue(binding);
        (userRepository.findById as jest.Mock).mockResolvedValue(activeUser);

        await guard.canActivate(createContext(request()));

        expect(apiKeyService.validateKey).not.toHaveBeenCalled();
    });

    it('accepts the token in the x-api-key slot too', async () => {
        const { guard, runCredentials, userRepository } = createGuard();
        runCredentials.authenticate.mockResolvedValue(binding);
        (userRepository.findById as jest.Mock).mockResolvedValue(activeUser);

        await expect(
            guard.canActivate(createContext(request({ headers: { 'x-api-key': RUN_TOKEN } }))),
        ).resolves.toBe(true);
    });

    it('refuses a rejected token with the SAME message a bad personal key gets', async () => {
        const { guard, runCredentials, authProvider } = createGuard();
        runCredentials.authenticate.mockResolvedValue(null);

        await expect(guard.canActivate(createContext(request()))).rejects.toThrow(
            new UnauthorizedException('Invalid or expired API key'),
        );
        // And it does NOT fall through to a session: a machine credential
        // asks for the machine path and gets a deterministic answer.
        expect(authProvider.authenticate).not.toHaveBeenCalled();
    });

    it('refuses when the run resolves to an inactive owner', async () => {
        const { guard, runCredentials, userRepository } = createGuard();
        runCredentials.authenticate.mockResolvedValue(binding);
        (userRepository.findById as jest.Mock).mockResolvedValue({
            ...activeUser,
            isActive: false,
        });

        await expect(guard.canActivate(createContext(request()))).rejects.toThrow(
            UnauthorizedException,
        );
    });

    it('fails closed on an install with no fleet module bound', async () => {
        const { guard } = createGuard({ noFleetModule: true });

        await expect(guard.canActivate(createContext(request()))).rejects.toThrow(
            new UnauthorizedException('Invalid or expired API key'),
        );
    });

    it('leaves an ordinary opaque bearer to the auth provider, exactly as before', async () => {
        const providerUser = { userId: 'session-user' };
        const { guard, runCredentials, apiKeyService, authProvider } = createGuard({
            providerUser,
        });

        const req = {
            method: 'GET',
            path: '/api/tasks',
            headers: { authorization: 'Bearer some-opaque-session-token' },
        } as any;
        await expect(guard.canActivate(createContext(req))).resolves.toBe(true);

        expect(req.user).toBe(providerUser);
        expect(req.fleetRunCredential).toBeUndefined();
        expect(runCredentials.authenticate).not.toHaveBeenCalled();
        expect(apiKeyService.validateKey).not.toHaveBeenCalled();
        expect(authProvider.authenticate).toHaveBeenCalled();
    });

    it('still routes an ew_live_ key to ApiKeyService and leaves no run binding', async () => {
        const { guard, runCredentials, apiKeyService, userRepository } = createGuard();
        (apiKeyService.validateKey as jest.Mock).mockResolvedValue({ userId: 'owner-1' });
        (userRepository.findById as jest.Mock).mockResolvedValue(activeUser);

        const req = {
            method: 'GET',
            path: '/api/tasks',
            headers: { authorization: 'Bearer ew_live_abcdef' },
        } as any;
        await expect(guard.canActivate(createContext(req))).resolves.toBe(true);

        expect(apiKeyService.validateKey).toHaveBeenCalledWith('ew_live_abcdef');
        expect(runCredentials.authenticate).not.toHaveBeenCalled();
        expect(req.fleetRunCredential).toBeUndefined();
    });
});
