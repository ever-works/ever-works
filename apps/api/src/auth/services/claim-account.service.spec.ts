jest.mock('@ever-works/agent/database', () => ({ UserRepository: class {} }));

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { ClaimAccountService } from './claim-account.service';

describe('ClaimAccountService (EW-617 G3)', () => {
    const buildService = () => {
        const findByIdResults: any = {};
        const findByEmailResults: any = {};
        const updates: any[] = [];

        const userRepository = {
            findById: jest.fn(async (id: string) => findByIdResults[id] ?? null),
            findByEmail: jest.fn(async (email: string) => findByEmailResults[email] ?? null),
            update: jest.fn(async (id: string, data: any) => {
                updates.push({ id, ...data });
                const base = findByIdResults[id] ?? { id };
                return { ...base, ...data };
            }),
        } as any;

        const authSyncService = {
            getCredentialPasswordHash: jest.fn().mockResolvedValue('hashed-pw'),
        } as any;

        const authService = {
            sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
        } as any;

        const authProvider = {
            setPassword: jest.fn().mockResolvedValue(undefined),
        } as any;

        const service = new ClaimAccountService(
            userRepository,
            authSyncService,
            authService,
            authProvider,
        );

        return {
            service,
            userRepository,
            authSyncService,
            authService,
            authProvider,
            findByIdResults,
            findByEmailResults,
            updates,
        };
    };

    const anonUser = (overrides: any = {}) => ({
        id: 'u-1',
        username: 'anon-deadbeef',
        email: null,
        password: null,
        isAnonymous: true,
        anonymousExpiresAt: new Date('2026-05-21T00:00:00.000Z'),
        emailVerified: false,
        ...overrides,
    });

    it('flips the anon user to a regular account and fires verification email', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        const result = await ctx.service.claim({
            userId: 'u-1',
            email: 'Jane@Example.com',
            password: 'MySecure123!',
        });

        // Password set via auth provider
        expect(ctx.authProvider.setPassword).toHaveBeenCalledWith('u-1', 'MySecure123!');

        // User row updated atomically
        expect(ctx.updates).toHaveLength(1);
        const updatePayload = ctx.updates[0];
        expect(updatePayload.email).toBe('jane@example.com'); // normalized
        expect(updatePayload.isAnonymous).toBe(false);
        expect(updatePayload.anonymousExpiresAt).toBeNull();
        expect(updatePayload.registrationProvider).toBe('local');
        expect(updatePayload.emailVerified).toBe(false);
        expect(updatePayload.username).toBe('anon-deadbeef'); // kept

        // Verification email pipeline kicked off
        expect(ctx.authService.sendVerificationEmail).toHaveBeenCalledWith('u-1', undefined);

        // Public response shape
        expect(result).toEqual({
            id: 'u-1',
            email: 'jane@example.com',
            username: 'anon-deadbeef',
            emailVerified: false,
        });
    });

    it('respects a custom username when long enough', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        await ctx.service.claim({
            userId: 'u-1',
            email: 'jane@example.com',
            password: 'MySecure123!',
            username: 'jane-doe',
        });

        expect(ctx.updates[0].username).toBe('jane-doe');
    });

    it('rejects too-short usernames', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
                username: 'jd',
            }),
        ).rejects.toThrow(BadRequestException);
    });

    it('returns 404 when the user does not exist', async () => {
        const ctx = buildService();

        await expect(
            ctx.service.claim({
                userId: 'ghost',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(NotFoundException);
    });

    it('returns 403 when the user is already a regular account', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser({ isAnonymous: false });

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(ForbiddenException);
    });

    it('returns 409 when the email belongs to a different user', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();
        ctx.findByEmailResults['jane@example.com'] = {
            id: 'u-someone-else',
            email: 'jane@example.com',
        };

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(ConflictException);

        // Confirm we never wrote anything
        expect(ctx.authProvider.setPassword).not.toHaveBeenCalled();
        expect(ctx.updates).toHaveLength(0);
    });

    it('allows claim when findByEmail returns the same user (e.g. retry)', async () => {
        const ctx = buildService();
        const sameUser = anonUser();
        ctx.findByIdResults['u-1'] = sameUser;
        ctx.findByEmailResults['jane@example.com'] = sameUser;

        await ctx.service.claim({
            userId: 'u-1',
            email: 'jane@example.com',
            password: 'MySecure123!',
        });

        expect(ctx.updates).toHaveLength(1);
    });

    it('does not throw if the verification email fails (logged + continued)', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();
        ctx.authService.sendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).resolves.toMatchObject({ id: 'u-1' });
    });

    it('throws when auth provider does not seat a credential hash', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();
        ctx.authSyncService.getCredentialPasswordHash.mockResolvedValue(null);

        await expect(
            ctx.service.claim({
                userId: 'u-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
            }),
        ).rejects.toThrow(BadRequestException);

        // The credential set was attempted but no User update should happen
        expect(ctx.authProvider.setPassword).toHaveBeenCalled();
        expect(ctx.updates).toHaveLength(0);
    });

    it('passes through the email verification callback URL', async () => {
        const ctx = buildService();
        ctx.findByIdResults['u-1'] = anonUser();

        await ctx.service.claim({
            userId: 'u-1',
            email: 'jane@example.com',
            password: 'MySecure123!',
            emailVerificationCallbackUrl: 'https://app.ever.works/welcome',
        });

        expect(ctx.authService.sendVerificationEmail).toHaveBeenCalledWith(
            'u-1',
            'https://app.ever.works/welcome',
        );
    });
});
