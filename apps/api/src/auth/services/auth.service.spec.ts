jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    User: class User {},
    Work: class Work {},
}));

// Stable env for config.webAppUrl()
const ORIGINAL_ENV = { ...process.env };
beforeAll(() => {
    process.env.WEB_URL = 'https://app.test';
});
afterAll(() => {
    process.env = ORIGINAL_ENV;
});

import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import type { UserRepository, AuthAccountRepository } from '@ever-works/agent/database';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { UserCreatedEvent, UserConfirmedEvent, UserForgotPasswordEvent } from '../../events';

describe('AuthService', () => {
    let service: AuthService;
    let userRepo: jest.Mocked<
        Pick<
            UserRepository,
            'findByEmail' | 'findById' | 'findOne' | 'create' | 'update' | 'clearPasswordResetToken'
        >
    >;
    let authAccountRepo: jest.Mocked<
        Pick<
            AuthAccountRepository,
            | 'findProviderAccount'
            | 'upsertProviderAccount'
            | 'findProviderAccountsByUserId'
            | 'isAccessTokenExpired'
            | 'hasRequiredScopes'
        >
    >;
    let emitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;

    beforeEach(() => {
        userRepo = {
            findByEmail: jest.fn(),
            findById: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            clearPasswordResetToken: jest.fn(),
        } as any;
        authAccountRepo = {
            findProviderAccount: jest.fn(),
            upsertProviderAccount: jest.fn(),
            findProviderAccountsByUserId: jest.fn(),
            isAccessTokenExpired: jest.fn(),
            hasRequiredScopes: jest.fn(),
        } as any;
        emitter = { emit: jest.fn() } as any;

        service = new AuthService(
            userRepo as unknown as UserRepository,
            authAccountRepo as unknown as AuthAccountRepository,
            emitter as unknown as EventEmitter2,
        );
    });

    describe('assertCanRegister', () => {
        it('throws ConflictException when user already exists', async () => {
            userRepo.findByEmail.mockResolvedValue({ id: 'u1' } as any);

            await expect(service.assertCanRegister('a@b.co')).rejects.toThrow(ConflictException);
        });

        it('resolves when no existing user', async () => {
            userRepo.findByEmail.mockResolvedValue(null);

            await expect(service.assertCanRegister('a@b.co')).resolves.toBeUndefined();
        });
    });

    describe('validateSocialUser', () => {
        const socialUser = (overrides: Record<string, unknown> = {}) => ({
            email: 'sa@b.co',
            displayName: 'SA',
            username: 'sa-user',
            provider: 'github',
            providerUserId: 'gh-1',
            accessToken: 'at',
            refreshToken: 'rt',
            tokenType: 'Bearer',
            expiresAt: null,
            scope: 'repo',
            avatar: 'avatar.png',
            emailVerified: true,
            metadata: { foo: 'bar' },
            ...overrides,
        });

        it('creates a new user when none exists and emits UserConfirmedEvent for trusted email', async () => {
            userRepo.findByEmail.mockResolvedValue(null);
            const created = { id: 'u-new', email: 'sa@b.co' };
            userRepo.create.mockResolvedValue(created as any);
            authAccountRepo.upsertProviderAccount.mockResolvedValue({} as any);
            jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashed' as never);

            const result = await service.validateSocialUser(socialUser() as any);

            expect(userRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    email: 'sa@b.co',
                    username: 'sa-user',
                    registrationProvider: 'github',
                    avatar: 'avatar.png',
                    emailVerified: true,
                    isActive: true,
                    password: 'hashed',
                }),
            );
            expect(emitter.emit).toHaveBeenCalledWith(
                UserConfirmedEvent.EVENT_NAME,
                expect.any(UserConfirmedEvent),
            );
            expect(result).toBe(created);
        });

        it('does NOT emit UserConfirmedEvent when emailVerified is false', async () => {
            userRepo.findByEmail.mockResolvedValue(null);
            userRepo.create.mockResolvedValue({ id: 'u-new', email: 'x' } as any);
            authAccountRepo.upsertProviderAccount.mockResolvedValue({} as any);
            jest.spyOn(bcrypt, 'hash').mockResolvedValue('h' as never);

            await service.validateSocialUser(
                socialUser({ emailVerified: false, displayName: undefined }) as any,
            );

            expect(emitter.emit).not.toHaveBeenCalled();
            expect(userRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ emailVerified: false }),
            );
        });

        it('falls back to email-prefix when displayName/username missing', async () => {
            userRepo.findByEmail.mockResolvedValue(null);
            userRepo.create.mockResolvedValue({ id: 'u-new' } as any);
            authAccountRepo.upsertProviderAccount.mockResolvedValue({} as any);
            jest.spyOn(bcrypt, 'hash').mockResolvedValue('h' as never);

            await service.validateSocialUser(
                socialUser({ displayName: '', username: '', email: 'jane@example.com' }) as any,
            );

            expect(userRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({ username: 'jane' }),
            );
        });

        it('throws UnauthorizedException when account suspended', async () => {
            userRepo.findByEmail.mockResolvedValue({
                id: 'u-1',
                isActive: false,
            } as any);

            await expect(service.validateSocialUser(socialUser() as any)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('rejects unverified email when no existing provider link', async () => {
            userRepo.findByEmail.mockResolvedValue({ id: 'u-1', isActive: true } as any);
            authAccountRepo.findProviderAccount.mockResolvedValue(null);

            await expect(
                service.validateSocialUser(socialUser({ emailVerified: false }) as any),
            ).rejects.toThrow(
                'Unable to link this social account because the provider email is not verified',
            );
        });

        it('allows unverified email when provider link already exists', async () => {
            userRepo.findByEmail.mockResolvedValue({
                id: 'u-1',
                isActive: true,
                username: 'old',
                avatar: 'old.png',
                emailVerified: true,
            } as any);
            authAccountRepo.findProviderAccount.mockResolvedValue({ id: 'acc-1' } as any);
            const updated = { id: 'u-1', email: 'sa@b.co' };
            userRepo.update.mockResolvedValue(updated as any);
            authAccountRepo.upsertProviderAccount.mockResolvedValue({} as any);

            const result = await service.validateSocialUser(
                socialUser({ emailVerified: false }) as any,
            );

            expect(result).toBe(updated);
            expect(userRepo.update).toHaveBeenCalledWith(
                'u-1',
                expect.objectContaining({
                    lastLoginAt: expect.any(Date),
                    registrationProvider: 'github',
                }),
            );
        });

        it('upserts provider account with correct fields', async () => {
            userRepo.findByEmail.mockResolvedValue(null);
            userRepo.create.mockResolvedValue({ id: 'u-new' } as any);
            jest.spyOn(bcrypt, 'hash').mockResolvedValue('h' as never);

            await service.validateSocialUser(socialUser() as any);

            expect(authAccountRepo.upsertProviderAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u-new',
                    providerId: 'github',
                    accountId: 'gh-1',
                    accessToken: 'at',
                    refreshToken: 'rt',
                    tokenType: 'Bearer',
                    accessTokenExpiresAt: null,
                    scope: 'repo',
                    metadata: { providerUserId: 'gh-1', foo: 'bar' },
                }),
            );
        });

        it('defaults tokenType to Bearer when missing', async () => {
            userRepo.findByEmail.mockResolvedValue(null);
            userRepo.create.mockResolvedValue({ id: 'u-new' } as any);
            jest.spyOn(bcrypt, 'hash').mockResolvedValue('h' as never);

            await service.validateSocialUser(
                socialUser({ tokenType: undefined, refreshToken: null, scope: null }) as any,
            );

            expect(authAccountRepo.upsertProviderAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    tokenType: 'Bearer',
                    refreshToken: null,
                    scope: null,
                }),
            );
        });
    });

    describe('sendVerificationEmail', () => {
        it('throws when user not found', async () => {
            userRepo.findById.mockResolvedValue(null);

            await expect(service.sendVerificationEmail('missing')).rejects.toThrow(
                'User not found',
            );
        });

        it('throws when email already verified', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u-1', emailVerified: true } as any);

            await expect(service.sendVerificationEmail('u-1')).rejects.toThrow(
                'Email already verified',
            );
        });

        it('issues a token, sets 24h expiry, emits UserCreatedEvent and returns the token', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u-1', emailVerified: false } as any);
            userRepo.update.mockResolvedValue({} as any);

            const result = await service.sendVerificationEmail('u-1');

            const updateInput = userRepo.update.mock.calls[0][1];
            expect(updateInput.emailVerificationToken).toBe(result.verificationToken);
            expect(updateInput.emailVerificationExpires).toBeInstanceOf(Date);
            const expiry = updateInput.emailVerificationExpires as Date;
            const diffMs = expiry.getTime() - Date.now();
            // Should be ~24 hours from now (allow 1 minute drift)
            expect(diffMs).toBeGreaterThan(23 * 60 * 60 * 1000);
            expect(diffMs).toBeLessThan(25 * 60 * 60 * 1000);
            expect(emitter.emit).toHaveBeenCalledWith(
                UserCreatedEvent.EVENT_NAME,
                expect.any(UserCreatedEvent),
            );
        });

        it('appends ?token= when callbackUrl missing token=', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u-1', emailVerified: false } as any);
            userRepo.update.mockResolvedValue({} as any);

            const result = await service.sendVerificationEmail('u-1', 'https://x.test/verify');

            const event = (emitter.emit.mock.calls[0][1] as UserCreatedEvent).confirmationUrl;
            expect(event).toBe(`https://x.test/verify?token=${result.verificationToken}`);
        });

        it('uses default callback URL when callbackUrl already has token=', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u-1', emailVerified: false } as any);
            userRepo.update.mockResolvedValue({} as any);

            const result = await service.sendVerificationEmail(
                'u-1',
                'https://x.test/verify?token=already',
            );

            const event = (emitter.emit.mock.calls[0][1] as UserCreatedEvent).confirmationUrl;
            // When token= already present, the service overrides with default URL
            expect(event).toBe(
                `https://app.test/api/auth/verify-email?token=${result.verificationToken}`,
            );
        });
    });

    describe('verifyEmail', () => {
        it('throws on invalid token', async () => {
            userRepo.findOne.mockResolvedValue(null);

            await expect(service.verifyEmail('bad')).rejects.toThrow('Invalid verification token');
        });

        it('throws on expired token', async () => {
            userRepo.findOne.mockResolvedValue({
                id: 'u',
                emailVerificationExpires: new Date(Date.now() - 1000),
            } as any);

            await expect(service.verifyEmail('t')).rejects.toThrow('Verification token expired');
        });

        it('marks email verified, clears token, emits UserConfirmedEvent', async () => {
            const user = { id: 'u', emailVerificationExpires: new Date(Date.now() + 1000) };
            const updated = { id: 'u', emailVerified: true };
            userRepo.findOne.mockResolvedValue(user as any);
            userRepo.findById.mockResolvedValue(updated as any);
            userRepo.update.mockResolvedValue({} as any);

            const result = await service.verifyEmail('t');

            expect(userRepo.update).toHaveBeenCalledWith('u', {
                emailVerified: true,
                emailVerificationToken: null,
                emailVerificationExpires: null,
            });
            expect(emitter.emit).toHaveBeenCalledWith(
                UserConfirmedEvent.EVENT_NAME,
                expect.any(UserConfirmedEvent),
            );
            expect(result).toBe(updated);
        });

        it('throws when updated user disappears', async () => {
            userRepo.findOne.mockResolvedValue({ id: 'u' } as any);
            userRepo.findById.mockResolvedValue(null);
            userRepo.update.mockResolvedValue({} as any);

            await expect(service.verifyEmail('t')).rejects.toThrow(
                'User not found after verification',
            );
        });
    });

    describe('forgotPassword', () => {
        it('returns generic message and skips emit when email unknown', async () => {
            userRepo.findByEmail.mockResolvedValue(null);

            const result = await service.forgotPassword({ email: 'no@one.test' } as any);

            expect(result).toEqual({ message: 'If the email exists, a reset link has been sent' });
            expect(emitter.emit).not.toHaveBeenCalled();
            expect(userRepo.update).not.toHaveBeenCalled();
        });

        it('issues reset token with 1h expiry and emits UserForgotPasswordEvent', async () => {
            userRepo.findByEmail.mockResolvedValue({ id: 'u-1' } as any);
            userRepo.update.mockResolvedValue({} as any);

            const result = await service.forgotPassword({
                email: 'a@b.co',
                resetPasswordCallbackUrl: 'https://x.test/reset',
            } as any);

            const updateInput = userRepo.update.mock.calls[0][1];
            expect(updateInput.passwordResetToken).toBe((result as any).resetToken);
            const expires = updateInput.passwordResetExpires as Date;
            expect(expires.getTime() - Date.now()).toBeGreaterThan(50 * 60 * 1000);
            expect(expires.getTime() - Date.now()).toBeLessThan(70 * 60 * 1000);
            expect(emitter.emit).toHaveBeenCalledWith(
                UserForgotPasswordEvent.EVENT_NAME,
                expect.any(UserForgotPasswordEvent),
            );
            const event = emitter.emit.mock.calls[0][1] as UserForgotPasswordEvent;
            expect(event.resetUrl).toBe(`https://x.test/reset?token=${(result as any).resetToken}`);
        });

        it('uses default URL when callbackUrl missing', async () => {
            userRepo.findByEmail.mockResolvedValue({ id: 'u-1' } as any);
            userRepo.update.mockResolvedValue({} as any);

            const result = await service.forgotPassword({ email: 'a@b.co' } as any);

            const event = emitter.emit.mock.calls[0][1] as UserForgotPasswordEvent;
            expect(event.resetUrl).toBe(
                `https://app.test/api/auth/reset-password?token=${(result as any).resetToken}`,
            );
        });
    });

    describe('getUserByPasswordResetToken', () => {
        it('throws on invalid token', async () => {
            userRepo.findOne.mockResolvedValue(null);

            await expect(service.getUserByPasswordResetToken('bad')).rejects.toThrow(
                'Invalid reset token',
            );
        });

        it('throws on expired token', async () => {
            userRepo.findOne.mockResolvedValue({
                id: 'u',
                passwordResetExpires: new Date(Date.now() - 1000),
            } as any);

            await expect(service.getUserByPasswordResetToken('t')).rejects.toThrow(
                'Reset token expired',
            );
        });

        it('returns the user when token valid', async () => {
            const user = {
                id: 'u',
                passwordResetExpires: new Date(Date.now() + 1000),
            };
            userRepo.findOne.mockResolvedValue(user as any);

            const result = await service.getUserByPasswordResetToken('t');

            expect(result).toBe(user);
        });
    });

    describe('consumePasswordResetToken', () => {
        it('throws when clearPasswordResetToken returns false', async () => {
            userRepo.findOne.mockResolvedValue({
                id: 'u',
                passwordResetExpires: new Date(Date.now() + 1000),
            } as any);
            userRepo.clearPasswordResetToken.mockResolvedValue(false);

            await expect(service.consumePasswordResetToken('t')).rejects.toThrow(
                'Invalid reset token',
            );
        });

        it('returns the user when consumed', async () => {
            const user = { id: 'u', passwordResetExpires: new Date(Date.now() + 1000) };
            userRepo.findOne.mockResolvedValue(user as any);
            userRepo.clearPasswordResetToken.mockResolvedValue(true);

            const result = await service.consumePasswordResetToken('t');

            expect(userRepo.clearPasswordResetToken).toHaveBeenCalledWith('u', 't');
            expect(result).toBe(user);
        });
    });

    describe('getUser', () => {
        it('returns the user from repository', async () => {
            const u = { id: 'u' };
            userRepo.findById.mockResolvedValue(u as any);

            await expect(service.getUser('u')).resolves.toBe(u);
        });

        it('returns null when not found', async () => {
            userRepo.findById.mockResolvedValue(null);

            await expect(service.getUser('u')).resolves.toBeNull();
        });
    });

    describe('getUserProfile', () => {
        it('throws when user not found', async () => {
            userRepo.findById.mockResolvedValue(null);

            await expect(service.getUserProfile('u')).rejects.toThrow('User not found');
        });

        it('returns sanitized profile with connected providers', async () => {
            userRepo.findById.mockResolvedValue({
                id: 'u',
                email: 'a@b.co',
                username: 'name',
                password: 'secret',
                emailVerificationToken: 't1',
                emailVerificationExpires: new Date(),
                passwordResetToken: 't2',
                passwordResetExpires: new Date(),
            } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                {
                    providerId: 'github',
                    accessToken: 'gh-token',
                    accessTokenExpiresAt: null,
                    scope: 'repo,user',
                    createdAt: new Date('2026-05-01'),
                },
                {
                    providerId: 'google',
                    accessToken: 'g-token',
                    accessTokenExpiresAt: null,
                    scope: 'profile',
                    createdAt: new Date('2026-05-02'),
                },
            ] as any);
            authAccountRepo.isAccessTokenExpired.mockReturnValue(false);
            authAccountRepo.hasRequiredScopes.mockReturnValue(true);

            const result = await service.getUserProfile('u');

            // Sensitive fields stripped
            expect((result as any).password).toBeUndefined();
            expect((result as any).emailVerificationToken).toBeUndefined();
            expect((result as any).emailVerificationExpires).toBeUndefined();
            expect((result as any).passwordResetToken).toBeUndefined();
            expect((result as any).passwordResetExpires).toBeUndefined();
            expect(result.oauthTokens).toEqual([
                { provider: 'github', createdAt: new Date('2026-05-01') },
                { provider: 'google', createdAt: new Date('2026-05-02') },
            ]);
        });

        it('excludes github provider when missing repo scope', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                {
                    providerId: 'github',
                    accessToken: 't',
                    accessTokenExpiresAt: null,
                    scope: 'user',
                    createdAt: new Date(),
                },
            ] as any);
            authAccountRepo.isAccessTokenExpired.mockReturnValue(false);
            authAccountRepo.hasRequiredScopes.mockReturnValue(false);

            const result = await service.getUserProfile('u');

            expect(result.oauthTokens).toEqual([]);
        });

        it('excludes provider when access token expired', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                {
                    providerId: 'google',
                    accessToken: 't',
                    accessTokenExpiresAt: new Date(Date.now() - 1000),
                    scope: 'profile',
                    createdAt: new Date(),
                },
            ] as any);
            authAccountRepo.isAccessTokenExpired.mockReturnValue(true);

            const result = await service.getUserProfile('u');

            expect(result.oauthTokens).toEqual([]);
        });

        it('excludes provider with no access token', async () => {
            userRepo.findById.mockResolvedValue({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                {
                    providerId: 'google',
                    accessToken: null,
                    accessTokenExpiresAt: null,
                    scope: 'profile',
                    createdAt: new Date(),
                },
            ] as any);

            const result = await service.getUserProfile('u');

            expect(result.oauthTokens).toEqual([]);
        });
    });

    describe('updateUserProfile', () => {
        it('throws when user not found', async () => {
            userRepo.findById.mockResolvedValue(null);

            await expect(
                service.updateUserProfile('u', { username: 'new' } as any),
            ).rejects.toThrow('User not found');
        });

        it('only updates supplied fields', async () => {
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            // Second findById call from getUserProfile after update
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([] as any);
            userRepo.update.mockResolvedValue({} as any);

            await service.updateUserProfile('u', { username: 'new' } as any);

            expect(userRepo.update).toHaveBeenCalledWith('u', { username: 'new' });
        });

        it('clears committer fields when explicitly set to empty string', async () => {
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([] as any);
            userRepo.update.mockResolvedValue({} as any);

            await service.updateUserProfile('u', {
                committerName: '',
                committerEmail: '',
            } as any);

            expect(userRepo.update).toHaveBeenCalledWith('u', {
                committerName: null,
                committerEmail: null,
            });
        });

        it('passes committer fields through when set', async () => {
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([] as any);
            userRepo.update.mockResolvedValue({} as any);

            await service.updateUserProfile('u', {
                committerName: 'Jane',
                committerEmail: 'jane@x.test',
            } as any);

            expect(userRepo.update).toHaveBeenCalledWith('u', {
                committerName: 'Jane',
                committerEmail: 'jane@x.test',
            });
        });

        it('skips null/undefined username and avatar', async () => {
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            userRepo.findById.mockResolvedValueOnce({ id: 'u' } as any);
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([] as any);
            userRepo.update.mockResolvedValue({} as any);

            await service.updateUserProfile('u', {
                username: null,
                avatar: undefined,
            } as any);

            expect(userRepo.update).toHaveBeenCalledWith('u', {});
        });
    });

    describe('validateEmailVerificationToken', () => {
        it('returns valid: false when token unknown', async () => {
            userRepo.findOne.mockResolvedValue(null);

            await expect(service.validateEmailVerificationToken('bad')).resolves.toEqual({
                valid: false,
                message: 'Invalid verification token',
            });
        });

        it('returns valid: false when expired', async () => {
            userRepo.findOne.mockResolvedValue({
                emailVerificationExpires: new Date(Date.now() - 1000),
            } as any);

            await expect(service.validateEmailVerificationToken('t')).resolves.toEqual({
                valid: false,
                message: 'Verification token expired',
            });
        });

        it('returns valid: true with email + expiry on success', async () => {
            const expiry = new Date(Date.now() + 1000);
            userRepo.findOne.mockResolvedValue({
                email: 'a@b.co',
                emailVerificationExpires: expiry,
            } as any);

            await expect(service.validateEmailVerificationToken('t')).resolves.toEqual({
                valid: true,
                message: 'Token is valid',
                email: 'a@b.co',
                expiresAt: expiry,
            });
        });
    });

    describe('validatePasswordResetToken', () => {
        it('returns valid: false when token unknown', async () => {
            userRepo.findOne.mockResolvedValue(null);

            await expect(service.validatePasswordResetToken('bad')).resolves.toEqual({
                valid: false,
                message: 'Invalid reset token',
            });
        });

        it('returns valid: false when expired', async () => {
            userRepo.findOne.mockResolvedValue({
                passwordResetExpires: new Date(Date.now() - 1000),
            } as any);

            await expect(service.validatePasswordResetToken('t')).resolves.toEqual({
                valid: false,
                message: 'Reset token expired',
            });
        });

        it('returns valid: true on success', async () => {
            const expiry = new Date(Date.now() + 1000);
            userRepo.findOne.mockResolvedValue({
                email: 'a@b.co',
                passwordResetExpires: expiry,
            } as any);

            await expect(service.validatePasswordResetToken('t')).resolves.toEqual({
                valid: true,
                message: 'Token is valid',
                email: 'a@b.co',
                expiresAt: expiry,
            });
        });
    });
});
