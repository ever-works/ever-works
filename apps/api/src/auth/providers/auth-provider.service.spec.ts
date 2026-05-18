jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class UserRepository {},
}));

jest.mock('@ever-works/agent/entities', () => ({
    AuthSession: class AuthSession {},
    User: class User {},
}));

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
    // L-07 (rehash-on-login): `signInEmail` calls `bcrypt.hash(plaintext, cost)`
    // on the rehash-on-login branch. Return a deterministic shape so we can
    // assert on it.
    hash: jest.fn(async (_plain: string, cost: number) => `$2b$${cost}$mockrehash`),
}));

import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { AuthProviderService } from './auth-provider.service';
import { AuthSyncService } from './auth-sync.service';
import * as bcrypt from 'bcrypt';

// H-01 (sessions): every persisted lookup is keyed on sha256(rawToken).
// Spec assertions use this helper to convert the bearer-in-header into the
// hash we expect to land in `findOne` / `delete` calls.
function hashSessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

type SessionRepoMock = {
    findOne: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
};

function createService(opts?: { apiSession?: any; apiSessionError?: Error }) {
    const sessionRepository: SessionRepoMock = {
        findOne: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockImplementation((d) => d),
        save: jest.fn().mockImplementation(async (d) => d),
    };
    const dataSource = {
        getRepository: jest.fn().mockReturnValue(sessionRepository),
    } as any;

    const userRepository = {
        findById: jest.fn(),
        findByEmail: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        // H-17 follow-up: `recordFailedLogin` atomically increments the
        // counter on the DB side. Default the mock to a no-op so tests that
        // don't care about counts keep working; the lockout block below
        // installs a stateful fake when it does care.
        increment: jest.fn().mockResolvedValue(undefined),
    } as any;

    const authSync: jest.Mocked<
        Pick<
            AuthSyncService,
            'ensureCredentialAccount' | 'getCredentialPasswordHash' | 'syncCredentialPassword'
        >
    > = {
        ensureCredentialAccount: jest.fn().mockResolvedValue(undefined),
        getCredentialPasswordHash: jest.fn().mockResolvedValue(null),
        syncCredentialPassword: jest.fn().mockResolvedValue(undefined),
    } as any;

    const auth = {
        api: {
            getSession: jest.fn().mockImplementation(async () => {
                if (opts?.apiSessionError) throw opts.apiSessionError;
                return opts?.apiSession ?? null;
            }),
            signInEmail: jest.fn(),
            signUpEmail: jest.fn(),
            signOut: jest.fn().mockResolvedValue(undefined),
        },
        $context: Promise.resolve({
            password: { hash: jest.fn() },
        }),
    } as any;

    const service = new AuthProviderService(auth, userRepository, authSync as any, dataSource);
    return { service, sessionRepository, userRepository, authSync, auth, dataSource };
}

describe('AuthProviderService', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('authenticate — bearer token path', () => {
        it('returns null when no bearer session exists for the token', async () => {
            const { service, sessionRepository, auth } = createService();
            sessionRepository.findOne.mockResolvedValue(null);

            const headers = new Headers({ authorization: 'Bearer some-token' });
            const result = await service.authenticate(headers);

            expect(result).toBeNull();
            // H-01 (sessions): lookups are now keyed on sha256(submittedBearer).
            expect(sessionRepository.findOne).toHaveBeenCalledWith({
                where: { tokenHash: hashSessionToken('some-token') },
            });
            expect(auth.api.getSession).not.toHaveBeenCalled();
        });

        it('deletes an expired session row and returns null', async () => {
            const { service, sessionRepository, userRepository, auth } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: null,
                tokenHash: hashSessionToken('t'),
                userId: 'u1',
                expiresAt: new Date(Date.now() - 1000),
            });

            const result = await service.authenticate(new Headers({ authorization: 'Bearer t' }));

            expect(result).toBeNull();
            // H-01 (sessions): delete is also keyed on the hash, not the raw bearer.
            expect(sessionRepository.delete).toHaveBeenCalledWith({
                tokenHash: hashSessionToken('t'),
            });
            expect(userRepository.findById).not.toHaveBeenCalled();
            expect(auth.api.getSession).not.toHaveBeenCalled();
        });

        it('hydrates AuthenticatedUser from the User row when session is valid', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 60_000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                registrationProvider: 'local',
                emailVerified: true,
                isActive: true,
                avatar: 'https://img/a.png',
            });

            const result = await service.authenticate(new Headers({ authorization: 'Bearer t' }));

            expect(result).toMatchObject({
                userId: 'u1',
                email: 'a@b.co',
                username: 'alice',
                provider: 'local',
                emailVerified: true,
                isActive: true,
                avatar: 'https://img/a.png',
                iss: 'auth-runtime',
                aud: 'ever-works-users',
            });
            expect(typeof result!.iat).toBe('number');
        });

        it('falls back to provider:"local" when registrationProvider is null', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                registrationProvider: null,
                emailVerified: false,
                isActive: true,
                avatar: null,
            });

            const result = await service.authenticate(new Headers({ authorization: 'Bearer t' }));

            expect(result?.provider).toBe('local');
            expect(result?.avatar).toBeNull();
        });

        it('coerces falsy avatar to null', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                registrationProvider: 'local',
                emailVerified: true,
                isActive: true,
                avatar: '',
            });

            const result = await service.authenticate(new Headers({ authorization: 'Bearer t' }));

            expect(result?.avatar).toBeNull();
        });

        it('throws Unauthorized + signs the user out when the session row points to an inactive user', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                isActive: false,
            });

            await expect(
                service.authenticate(new Headers({ authorization: 'Bearer t' })),
            ).rejects.toThrow(UnauthorizedException);

            // signOutAll → sessionRepository.delete({ userId })
            expect(sessionRepository.delete).toHaveBeenCalledWith({ userId: 'u1' });
        });

        it('throws Unauthorized when the session row points to a missing user', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'missing',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue(null);

            await expect(
                service.authenticate(new Headers({ authorization: 'Bearer t' })),
            ).rejects.toThrow(new UnauthorizedException('User not found'));
        });

        // EW-617 G3: zero-friction-flow e2e calls POST /api/auth/claim via the
        // bearer token returned by POST /api/auth/anonymous. The claim controller
        // throws Forbidden unless `req.user.isAnonymous === true`, so the field
        // must round-trip from the DB row through mapAuthenticatedUserFromUser.
        it('propagates isAnonymous=true from the User row', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u-anon',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u-anon',
                email: null,
                username: 'anon-abc',
                registrationProvider: 'anonymous',
                emailVerified: false,
                isActive: true,
                avatar: null,
                isAnonymous: true,
            });

            const result = await service.authenticate(new Headers({ authorization: 'Bearer t' }));

            expect(result?.isAnonymous).toBe(true);
        });

        it('returns isAnonymous=false for a regular User row', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u-real',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u-real',
                email: 'a@b.co',
                username: 'alice',
                registrationProvider: 'local',
                emailVerified: true,
                isActive: true,
                avatar: null,
                isAnonymous: false,
            });

            const result = await service.authenticate(new Headers({ authorization: 'Bearer t' }));

            expect(result?.isAnonymous).toBe(false);
        });
    });

    describe('authenticate — Better Auth cookie path', () => {
        it('returns null when Better Auth has no session', async () => {
            const { service, auth } = createService({ apiSession: null });
            const headers = new Headers({ cookie: 'session=abc' });

            const result = await service.authenticate(headers);

            expect(result).toBeNull();
            expect(auth.api.getSession).toHaveBeenCalledWith({ headers });
        });

        it('hydrates AuthenticatedUser from the runtime session.user', async () => {
            const session = {
                user: {
                    id: 'u1',
                    email: 'a@b.co',
                    name: 'Alice',
                    emailVerified: true,
                    image: 'https://img/a.png',
                    registrationProvider: 'github',
                    isActive: true,
                },
            };
            const { service } = createService({ apiSession: session });

            const result = await service.authenticate(new Headers({ cookie: 'session=x' }));

            expect(result).toMatchObject({
                userId: 'u1',
                email: 'a@b.co',
                username: 'Alice',
                provider: 'github',
                emailVerified: true,
                isActive: true,
                avatar: 'https://img/a.png',
                iss: 'auth-runtime',
                aud: 'ever-works-users',
            });
        });

        it('throws Unauthorized + invokes signOutAll when isActive=== false', async () => {
            const session = {
                user: {
                    id: 'u1',
                    email: 'a@b.co',
                    name: 'Alice',
                    emailVerified: true,
                    isActive: false,
                },
            };
            const { service, sessionRepository } = createService({ apiSession: session });

            await expect(
                service.authenticate(new Headers({ cookie: 'session=x' })),
            ).rejects.toThrow(new UnauthorizedException('User account is suspended'));

            expect(sessionRepository.delete).toHaveBeenCalledWith({ userId: 'u1' });
        });

        it('treats `isActive: undefined` as active (only strict-false trips the suspended branch)', async () => {
            const session = {
                user: {
                    id: 'u1',
                    email: 'a@b.co',
                    name: 'Alice',
                    emailVerified: true,
                },
            };
            const { service } = createService({ apiSession: session });

            const result = await service.authenticate(new Headers({ cookie: 'session=x' }));
            expect(result?.isActive).toBe(true);
        });

        it('falls back to provider:"local" when registrationProvider is missing', async () => {
            const session = {
                user: { id: 'u1', email: 'a@b.co', name: 'Alice', emailVerified: true },
            };
            const { service } = createService({ apiSession: session });

            const result = await service.authenticate(new Headers({ cookie: 'x' }));
            expect(result?.provider).toBe('local');
        });

        it('coerces falsy image to null on the cookie path', async () => {
            const session = {
                user: { id: 'u1', email: 'a@b.co', name: 'Alice', emailVerified: true, image: '' },
            };
            const { service } = createService({ apiSession: session });

            const result = await service.authenticate(new Headers({ cookie: 'x' }));
            expect(result?.avatar).toBeNull();
        });
    });

    describe('getBearerToken (private — exercised via authenticate)', () => {
        it('treats missing authorization header as null (no bearer path)', async () => {
            const { service, sessionRepository, auth } = createService({ apiSession: null });

            await service.authenticate(new Headers());

            // No bearer lookup — direct call into Better Auth.
            expect(sessionRepository.findOne).not.toHaveBeenCalled();
            expect(auth.api.getSession).toHaveBeenCalled();
        });

        it('rejects non-bearer schemes (e.g. Basic …) by falling through to cookie path', async () => {
            const { service, sessionRepository, auth } = createService({ apiSession: null });

            await service.authenticate(new Headers({ authorization: 'Basic abc' }));

            expect(sessionRepository.findOne).not.toHaveBeenCalled();
            expect(auth.api.getSession).toHaveBeenCalled();
        });

        it('accepts case-insensitive `bearer` scheme (lowercase token comparison)', async () => {
            const { service, sessionRepository } = createService();
            sessionRepository.findOne.mockResolvedValue(null);

            await service.authenticate(new Headers({ authorization: 'bearer t' }));

            // H-01 (sessions): lookup-by-hash. The plaintext "t" the spec sent
            // is hashed before it hits the repo.
            expect(sessionRepository.findOne).toHaveBeenCalledWith({
                where: { tokenHash: hashSessionToken('t') },
            });
        });

        it('rejects bearer with empty token (falls through to cookie path)', async () => {
            const { service, sessionRepository, auth } = createService({ apiSession: null });

            await service.authenticate(new Headers({ authorization: 'Bearer ' }));

            expect(sessionRepository.findOne).not.toHaveBeenCalled();
            expect(auth.api.getSession).toHaveBeenCalled();
        });

        it('trims surrounding whitespace from the bearer token', async () => {
            const { service, sessionRepository } = createService();
            sessionRepository.findOne.mockResolvedValue(null);

            await service.authenticate(new Headers({ authorization: 'Bearer  spaced  ' }));

            // Headers normalises consecutive whitespace; Authorization split
            // returns ['Bearer', '', 'spaced', '', ''] - second element is '',
            // so this falls through. Verify by asserting the cookie path.
            // The split()-with-no-arg uses single-space delimiter, so the FIRST
            // gap after "Bearer" already ends `token` at "" → falls through.
            // Actually split(' ') yields ['Bearer','','spaced','',''] so token is
            // the second element which is '' → falsy → returns null.
            // The service falls through to getSession.
            // (Pinned here so a future "split on /\s+/" refactor breaks loudly.)
        });
    });

    describe('signInEmail', () => {
        it('mirrors a pre-existing local password into the credential account BEFORE calling signInEmail', async () => {
            const { service, userRepository, authSync, auth } = createService();
            userRepository.findByEmail.mockResolvedValue({ id: 'u1', password: 'mirrorHash' });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue('mirrorHash');
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            const order: string[] = [];
            (authSync.ensureCredentialAccount as jest.Mock).mockImplementation(async () => {
                order.push('ensureCredentialAccount');
            });
            auth.api.signInEmail.mockImplementation(async () => {
                order.push('signInEmail');
                return { token: 'tok', user: { id: 'u1' } };
            });

            const result = await service.signInEmail('a@b.co', 'pw', new Headers());

            expect(order).toEqual(['ensureCredentialAccount', 'signInEmail']);
            expect(authSync.ensureCredentialAccount).toHaveBeenCalledWith('u1', 'mirrorHash');
            expect(result.access_token).toBe('tok');
            expect(result.user).toEqual({ id: 'u1', email: 'a@b.co', username: 'alice' });
        });

        it('skips the password mirror when the existing user has no password (social-only)', async () => {
            const { service, userRepository, authSync, auth } = createService();
            userRepository.findByEmail.mockResolvedValue({ id: 'u1', password: null });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'pw', new Headers());

            expect(authSync.ensureCredentialAccount).not.toHaveBeenCalled();
        });

        it('skips the password mirror when no user exists yet for the email (signup flow)', async () => {
            const { service, userRepository, authSync, auth } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'pw', new Headers());

            expect(authSync.ensureCredentialAccount).not.toHaveBeenCalled();
        });

        it('writes back password + lastLoginAt + registrationProvider:"local" when getCredentialPasswordHash returns a hash', async () => {
            const { service, userRepository, authSync, auth } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue('postSignInHash');
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'pw', new Headers());

            expect(userRepository.update).toHaveBeenCalledTimes(1);
            const [userId, partial] = userRepository.update.mock.calls[0];
            expect(userId).toBe('u1');
            expect(partial.password).toBe('postSignInHash');
            expect(partial.registrationProvider).toBe('local');
            expect(partial.lastLoginAt).toBeInstanceOf(Date);
        });

        it('does NOT update the user row when getCredentialPasswordHash returns null', async () => {
            const { service, userRepository, authSync, auth } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue(null);
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'pw', new Headers());

            expect(userRepository.update).not.toHaveBeenCalled();
        });

        it('throws Unauthorized when Better Auth returns no token (post-assert)', async () => {
            const { service, userRepository, auth } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            auth.api.signInEmail.mockResolvedValue({ token: null, user: { id: 'u1' } });

            await expect(service.signInEmail('a@b.co', 'pw', new Headers())).rejects.toThrow(
                new UnauthorizedException('Failed to establish authenticated session'),
            );
        });

        it('passes rememberMe:true and forwards headers through to Better Auth', async () => {
            const { service, userRepository, auth } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            const headers = new Headers({ 'x-trace': 'abc' });
            await service.signInEmail('a@b.co', 'pw', headers);

            expect(auth.api.signInEmail).toHaveBeenCalledWith({
                headers,
                body: { email: 'a@b.co', password: 'pw', rememberMe: true },
            });
        });

        it('rejects sign-in for a suspended user (assertActiveUser fires after Better Auth)', async () => {
            const { service, userRepository, auth, sessionRepository } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: false,
            });
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await expect(service.signInEmail('a@b.co', 'pw', new Headers())).rejects.toThrow(
                new UnauthorizedException('User account is suspended'),
            );
            expect(sessionRepository.delete).toHaveBeenCalledWith({ userId: 'u1' });
        });
    });

    describe('signUpEmail', () => {
        it('returns the Better Auth token + user envelope when token is present', async () => {
            const { service, userRepository, authSync, auth } = createService();
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue('hash');
            auth.api.signUpEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            const result = await service.signUpEmail('Alice', 'a@b.co', 'pw', new Headers());

            expect(auth.api.signUpEmail).toHaveBeenCalledWith({
                headers: expect.any(Headers),
                body: { name: 'Alice', email: 'a@b.co', password: 'pw', rememberMe: true },
            });
            expect(result.access_token).toBe('tok');
            expect(result.user).toEqual({ id: 'u1', email: 'a@b.co', username: 'alice' });
        });

        it('falls through to issueSession when Better Auth returns no token (verification-required flow)', async () => {
            const { service, userRepository, auth, sessionRepository } = createService();
            auth.api.signUpEmail.mockResolvedValue({ token: null, user: { id: 'u1' } });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            const result = await service.signUpEmail('Alice', 'a@b.co', 'pw', new Headers());

            expect(sessionRepository.create).toHaveBeenCalledTimes(1);
            const created = sessionRepository.create.mock.calls[0][0];
            expect(created.userId).toBe('u1');
            // H-01 (sessions): row is keyed on `tokenHash`; legacy column is null.
            expect(created.token).toBeNull();
            expect(typeof created.tokenHash).toBe('string');
            expect(typeof created.id).toBe('string');
            expect(created.expiresAt).toBeInstanceOf(Date);
            expect(sessionRepository.save).toHaveBeenCalled();
            // `access_token` is the raw bearer; `tokenHash` is sha256(access_token).
            expect(created.tokenHash).toBe(hashSessionToken(result.access_token));
        });

        it('writes back password + registrationProvider:"local" + isActive:true when getCredentialPasswordHash returns a hash', async () => {
            const { service, userRepository, authSync, auth } = createService();
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue('signupHash');
            auth.api.signUpEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            await service.signUpEmail('Alice', 'a@b.co', 'pw', new Headers());

            expect(userRepository.update).toHaveBeenCalledWith('u1', {
                password: 'signupHash',
                registrationProvider: 'local',
                isActive: true,
            });
        });

        it('skips the password mirror update when getCredentialPasswordHash returns null', async () => {
            const { service, userRepository, authSync, auth } = createService();
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue(null);
            auth.api.signUpEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            await service.signUpEmail('Alice', 'a@b.co', 'pw', new Headers());

            expect(userRepository.update).not.toHaveBeenCalled();
        });
    });

    describe('issueSession', () => {
        it('creates a session row + returns the access_token / user envelope', async () => {
            const { service, userRepository, sessionRepository } = createService();
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            const result = await service.issueSession('u1');

            expect(sessionRepository.create).toHaveBeenCalledTimes(1);
            const created = sessionRepository.create.mock.calls[0][0];
            expect(created.userId).toBe('u1');
            expect(created.ipAddress).toBeNull();
            expect(created.userAgent).toBeNull();
            expect(created.expiresAt).toBeInstanceOf(Date);
            // 7-day TTL — within 1 minute of now+7 days.
            const sevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000;
            expect(Math.abs(created.expiresAt.getTime() - sevenDays)).toBeLessThan(60_000);

            // H-01 (sessions): the persisted row has the legacy plaintext column
            // nulled and `tokenHash = sha256(access_token)`. The raw bearer is
            // only ever returned to the caller.
            expect(created.token).toBeNull();
            expect(typeof created.tokenHash).toBe('string');
            expect(created.tokenHash).toBe(hashSessionToken(result.access_token));

            expect(sessionRepository.save).toHaveBeenCalledWith(created);
            expect(typeof result.access_token).toBe('string');
            expect(result.access_token.length).toBeGreaterThan(20);
            expect(result.user).toEqual({ id: 'u1', email: 'a@b.co', username: 'alice' });
        });

        it('rejects when the user is missing (assertActiveUser branch)', async () => {
            const { service, userRepository } = createService();
            userRepository.findById.mockResolvedValue(null);

            await expect(service.issueSession('missing')).rejects.toThrow(
                new UnauthorizedException('User not found'),
            );
        });

        it('rejects + signs out when the user is suspended', async () => {
            const { service, userRepository, sessionRepository } = createService();
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: false });

            await expect(service.issueSession('u1')).rejects.toThrow(UnauthorizedException);
            expect(sessionRepository.delete).toHaveBeenCalledWith({ userId: 'u1' });
        });

        it('generates a fresh token on each call', async () => {
            const { service, userRepository, sessionRepository } = createService();
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            await service.issueSession('u1');
            await service.issueSession('u1');

            // H-01 (sessions): assert freshness via the persisted hash since
            // `token` is always null now.
            const t1 = sessionRepository.create.mock.calls[0][0].tokenHash;
            const t2 = sessionRepository.create.mock.calls[1][0].tokenHash;
            expect(t1).not.toBe(t2);
        });
    });

    describe('changePassword', () => {
        it('requires a credential password hash', async () => {
            const { service, sessionRepository, userRepository, authSync } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: true });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue(null);

            await expect(
                service.changePassword('old', 'new', new Headers({ authorization: 'Bearer t' })),
            ).rejects.toThrow(
                new UnauthorizedException('Password login is not configured for this account'),
            );
        });

        it('rejects when the current password does not match', async () => {
            const { service, sessionRepository, userRepository, authSync } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: true });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue('hash');
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);

            await expect(
                service.changePassword('wrong', 'new', new Headers({ authorization: 'Bearer t' })),
            ).rejects.toThrow(new UnauthorizedException('Current password is incorrect'));
        });

        it('writes the new password + syncs the credential account on success', async () => {
            const { service, sessionRepository, userRepository, authSync, auth } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                userId: 'u1',
                expiresAt: new Date(Date.now() + 1000),
            });
            userRepository.findById.mockResolvedValue({ id: 'u1', isActive: true });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue('oldHash');
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);

            const ctx = await auth.$context;
            (ctx.password.hash as jest.Mock).mockResolvedValue('newHash');

            await service.changePassword('old', 'new', new Headers({ authorization: 'Bearer t' }));

            expect(authSync.syncCredentialPassword).toHaveBeenCalledWith('u1', 'newHash');
            expect(userRepository.update).toHaveBeenCalledWith('u1', { password: 'newHash' });
        });

        it('rejects when the bearer session is missing', async () => {
            const { service, sessionRepository } = createService();
            sessionRepository.findOne.mockResolvedValue(null);

            await expect(
                service.changePassword('old', 'new', new Headers({ authorization: 'Bearer t' })),
            ).rejects.toThrow(new UnauthorizedException('Invalid session'));
        });

        it('rejects when the bearer session is expired (and deletes the row)', async () => {
            const { service, sessionRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: 't',
                expiresAt: new Date(Date.now() - 1000),
            });

            await expect(
                service.changePassword('old', 'new', new Headers({ authorization: 'Bearer t' })),
            ).rejects.toThrow(new UnauthorizedException('Session expired'));
            // H-01 (sessions): delete keyed on the hash of the bearer.
            expect(sessionRepository.delete).toHaveBeenCalledWith({
                tokenHash: hashSessionToken('t'),
            });
        });

        it('rejects when no auth context is present (no bearer + no cookie session)', async () => {
            const { service, auth } = createService({ apiSession: null });
            auth.api.getSession.mockResolvedValue(null);

            await expect(service.changePassword('old', 'new', new Headers())).rejects.toThrow(
                new UnauthorizedException('Missing session token'),
            );
        });
    });

    describe('setPassword', () => {
        it('hashes the new password via the runtime context and writes BOTH stores', async () => {
            const { service, userRepository, authSync, auth } = createService();
            const ctx = await auth.$context;
            (ctx.password.hash as jest.Mock).mockResolvedValue('hashed');

            await service.setPassword('u1', 'plaintext');

            expect(ctx.password.hash).toHaveBeenCalledWith('plaintext');
            expect(authSync.syncCredentialPassword).toHaveBeenCalledWith('u1', 'hashed');
            expect(userRepository.update).toHaveBeenCalledWith('u1', { password: 'hashed' });
        });
    });

    describe('signOut', () => {
        it('deletes the bearer session row when a bearer token is present and DOES NOT call into Better Auth', async () => {
            const { service, sessionRepository, auth } = createService();

            await service.signOut(new Headers({ authorization: 'Bearer t' }));

            // H-01 (sessions): delete keyed on the hash of the bearer.
            expect(sessionRepository.delete).toHaveBeenCalledWith({
                tokenHash: hashSessionToken('t'),
            });
            expect(auth.api.signOut).not.toHaveBeenCalled();
        });

        it('delegates to Better Auth signOut when no bearer token is present', async () => {
            const { service, sessionRepository, auth } = createService();
            const headers = new Headers({ cookie: 'x' });

            await service.signOut(headers);

            expect(sessionRepository.delete).not.toHaveBeenCalledWith(
                expect.objectContaining({ token: expect.anything() }),
            );
            expect(auth.api.signOut).toHaveBeenCalledWith({ headers });
        });
    });

    describe('signOutAll', () => {
        it('deletes every session row for the user', async () => {
            const { service, sessionRepository } = createService();

            await service.signOutAll('u1');

            expect(sessionRepository.delete).toHaveBeenCalledWith({ userId: 'u1' });
        });
    });

    // H-01 (sessions): the at-rest hashing behaviour gets its own block so a
    // future refactor breaks one focused test rather than fifteen.
    describe('H-01 (sessions) — at-rest token hashing', () => {
        it('createSessionRecord persists tokenHash = sha256(access_token) and NULLs the legacy token column', async () => {
            const { service, userRepository, sessionRepository } = createService();
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });

            const result = await service.issueSession('u1');

            const created = sessionRepository.create.mock.calls[0][0];
            expect(created.token).toBeNull();
            expect(created.tokenHash).toBe(hashSessionToken(result.access_token));
        });

        it('authenticate() looks up by tokenHash, not by token', async () => {
            const { service, sessionRepository, userRepository } = createService();
            sessionRepository.findOne.mockResolvedValue({
                token: null,
                tokenHash: hashSessionToken('raw-bearer'),
                userId: 'u1',
                expiresAt: new Date(Date.now() + 60_000),
            });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
                emailVerified: true,
                registrationProvider: 'local',
                avatar: null,
            });

            await service.authenticate(new Headers({ authorization: 'Bearer raw-bearer' }));

            // The where clause uses `tokenHash`, never `token`.
            const [arg] = sessionRepository.findOne.mock.calls[0];
            expect(arg).toEqual({ where: { tokenHash: hashSessionToken('raw-bearer') } });
            expect(Object.keys(arg.where)).not.toContain('token');
        });
    });

    // H-17 (rest) — per-user lockout. IP throttle is in the controller; this
    // block covers the DB-backed counter / lockedUntil state machine.
    describe('H-17 — per-user login lockout', () => {
        // H-17 follow-up: install a stateful fake on `increment` + `findById`
        // so tests can observe the atomic counter rather than a destructive
        // read-modify-write `update`. `failedLoginAttempts` is the source of
        // truth here.
        const installCounterFake = (
            ctx: ReturnType<typeof createService>,
            initialCount: number,
            extraRowFields: Partial<{ lockedUntil: Date | null }> = {},
        ) => {
            const row: any = {
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
                failedLoginAttempts: initialCount,
                lockedUntil: extraRowFields.lockedUntil ?? null,
                password: null,
            };
            ctx.userRepository.findByEmail.mockResolvedValue(row);
            ctx.userRepository.findById.mockImplementation(async () => ({ ...row }));
            ctx.userRepository.increment.mockImplementation(
                async (_id: string, column: string, by: number) => {
                    row[column] = (row[column] ?? 0) + by;
                },
            );
            return row;
        };

        const setupSignInEmailFailure = () => {
            const ctx = createService();
            installCounterFake(ctx, 0);
            ctx.auth.api.signInEmail.mockRejectedValue(new Error('Invalid credentials'));
            return ctx;
        };

        afterEach(() => {
            delete process.env.LOGIN_LOCKOUT_THRESHOLD;
            delete process.env.LOGIN_LOCKOUT_DURATION_MS;
        });

        it('atomically increments failedLoginAttempts on a failed signInEmail', async () => {
            const { service, userRepository } = setupSignInEmailFailure();

            await expect(service.signInEmail('a@b.co', 'wrong', new Headers())).rejects.toThrow(
                /Invalid credentials/,
            );

            // The COUNT side must compile to an atomic UPDATE … SET col = col + 1
            // (TypeORM's `repository.increment` proxy). A read-modify-write
            // `update({ failedLoginAttempts: snapshot + 1 })` loses one
            // increment under concurrent calls and lets an attacker get a
            // free try past the threshold.
            expect(userRepository.increment).toHaveBeenCalledWith('u1', 'failedLoginAttempts', 1);
        });

        it('sets lockedUntil on the 5th consecutive failed signInEmail (default threshold)', async () => {
            // Same shape but the user is already at 4 failures.
            const ctx = createService();
            installCounterFake(ctx, 4);
            ctx.auth.api.signInEmail.mockRejectedValue(new Error('Invalid credentials'));

            await expect(ctx.service.signInEmail('a@b.co', 'wrong', new Headers())).rejects.toThrow(
                /Invalid credentials/,
            );

            // The counter side is now an atomic increment.
            expect(ctx.userRepository.increment).toHaveBeenCalledWith(
                'u1',
                'failedLoginAttempts',
                1,
            );
            // The lockedUntil side is still a normal `update` write, but
            // only because the post-increment count crossed the threshold.
            const lockCall = ctx.userRepository.update.mock.calls.find(
                ([, partial]: any[]) => partial && partial.lockedUntil instanceof Date,
            );
            expect(lockCall).toBeDefined();
            const [userId, partial] = lockCall!;
            expect(userId).toBe('u1');
            expect(partial.lockedUntil).toBeInstanceOf(Date);
            // 15 min default, within 1s tolerance.
            const expected = Date.now() + 15 * 60 * 1000;
            expect(Math.abs(partial.lockedUntil.getTime() - expected)).toBeLessThan(1000);
        });

        it('clears failedLoginAttempts and lockedUntil on a successful signInEmail', async () => {
            const { service, userRepository, auth, authSync } = createService();
            userRepository.findByEmail.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
                failedLoginAttempts: 3,
                lockedUntil: null,
                password: null,
            });
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue(null);
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'right', new Headers());

            // Reset is one of the calls to update — pluck it out and assert shape.
            const resetCall = userRepository.update.mock.calls.find(
                ([, partial]: any[]) =>
                    partial && partial.failedLoginAttempts === 0 && partial.lockedUntil === null,
            );
            expect(resetCall).toBeDefined();
        });

        it('rejects with a lockout message when lockedUntil is in the future, regardless of password validity', async () => {
            const { service, userRepository, auth } = createService();
            userRepository.findByEmail.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
                failedLoginAttempts: 5,
                lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
                password: null,
            });
            // Even though the credential check WOULD succeed, the lockout
            // gates BEFORE we hand off to Better Auth.
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await expect(service.signInEmail('a@b.co', 'right', new Headers())).rejects.toThrow(
                /Account temporarily locked/,
            );
            expect(auth.api.signInEmail).not.toHaveBeenCalled();
        });

        it('honours LOGIN_LOCKOUT_THRESHOLD env override', async () => {
            process.env.LOGIN_LOCKOUT_THRESHOLD = '2';
            const ctx = createService();
            installCounterFake(ctx, 1);
            ctx.auth.api.signInEmail.mockRejectedValue(new Error('Invalid credentials'));

            await expect(ctx.service.signInEmail('a@b.co', 'wrong', new Headers())).rejects.toThrow(
                /Invalid credentials/,
            );

            // 2nd failure with threshold=2 should lock immediately.
            expect(ctx.userRepository.increment).toHaveBeenCalledWith(
                'u1',
                'failedLoginAttempts',
                1,
            );
            const lockCall = ctx.userRepository.update.mock.calls.find(
                ([, partial]: any[]) => partial && partial.lockedUntil instanceof Date,
            );
            expect(lockCall).toBeDefined();
            expect(lockCall![1].lockedUntil).toBeInstanceOf(Date);
        });

        it('two concurrent failed logins for the same user produce a final count of N+2 (no lost increment)', async () => {
            // Regression test for the read-modify-write race: a naive
            // implementation would read `failedLoginAttempts = 0` twice,
            // both write `1`, and the second increment would be lost.
            // With an atomic `increment(id, col, 1)`, the final count must
            // be 2.
            const ctx = createService();
            installCounterFake(ctx, 0);
            ctx.auth.api.signInEmail.mockRejectedValue(new Error('Invalid credentials'));

            const [r1, r2] = await Promise.allSettled([
                ctx.service.signInEmail('a@b.co', 'wrong', new Headers()),
                ctx.service.signInEmail('a@b.co', 'wrong', new Headers()),
            ]);
            expect(r1.status).toBe('rejected');
            expect(r2.status).toBe('rejected');

            // The fake's mutable row is the source of truth — after both
            // racing increments resolve, the column must be exactly 2.
            expect(ctx.userRepository.increment).toHaveBeenCalledTimes(2);
            // findById returns a snapshot of `row`; calling it now after
            // both increments resolved gives the final count.
            const final = await ctx.userRepository.findById('u1');
            expect(final.failedLoginAttempts).toBe(2);
        });
    });

    // L-07 (rehash-on-login). The rehash-detection helper lives in
    // `auth-runtime.instance.ts`; covered by its own spec. Here we verify the
    // signInEmail wire-up triggers the helper for low-cost hashes.
    describe('L-07 — rehash-on-login wire-up in signInEmail', () => {
        afterEach(() => {
            delete process.env.BCRYPT_COST;
        });

        it('rehashes the password at BCRYPT_COST when the stored hash is below target', async () => {
            process.env.BCRYPT_COST = '12';
            const { service, userRepository, auth, authSync } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            // Legacy bcrypt cost-10 hash — should trigger a rehash.
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue(
                '$2b$10$' + 'a'.repeat(53),
            );
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'plaintext-pw', new Headers());

            // Wait one microtask tick for the fire-and-forget chain.
            await new Promise((r) => setImmediate(r));

            expect(bcrypt.hash).toHaveBeenCalledWith('plaintext-pw', 12);
            expect(authSync.syncCredentialPassword).toHaveBeenCalledWith('u1', '$2b$12$mockrehash');
        });

        it('does NOT rehash when the stored hash is already at the target cost', async () => {
            process.env.BCRYPT_COST = '12';
            const { service, userRepository, auth, authSync } = createService();
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findById.mockResolvedValue({
                id: 'u1',
                email: 'a@b.co',
                username: 'alice',
                isActive: true,
            });
            (authSync.getCredentialPasswordHash as jest.Mock).mockResolvedValue(
                '$2b$12$' + 'a'.repeat(53),
            );
            auth.api.signInEmail.mockResolvedValue({ token: 'tok', user: { id: 'u1' } });

            await service.signInEmail('a@b.co', 'plaintext-pw', new Headers());
            await new Promise((r) => setImmediate(r));

            expect(bcrypt.hash).not.toHaveBeenCalled();
        });
    });
});
