import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateApiKeyDto } from './api-key.dto';
import { LoginDto, OAuthCallbackDto, RegisterDto, UpdatePasswordDto } from './auth.dto';
import {
    ForgotPasswordDto,
    ResendVerificationDto,
    ResetPasswordDto,
    VerifyEmailDto,
} from './email-verification.dto';
import { UpdateProfileDto } from './update-profile.dto';

const constraintsFor = (errs: { property: string; constraints?: Record<string, string> }[], property: string) =>
    errs.find((e) => e.property === property)?.constraints ?? {};

describe('apps/api auth DTO validation', () => {
    describe('RegisterDto', () => {
        const valid = {
            username: 'johndoe',
            email: 'john@example.com',
            password: 'pass1word',
        };

        it('accepts a fully valid registration payload', async () => {
            const dto = plainToInstance(RegisterDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts an optional emailVerificationCallbackUrl', async () => {
            const dto = plainToInstance(RegisterDto, {
                ...valid,
                emailVerificationCallbackUrl: 'https://example.com/verify',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects username shorter than 3 chars via @MinLength(3)', async () => {
            const dto = plainToInstance(RegisterDto, { ...valid, username: 'ab' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'username').minLength).toBeDefined();
        });

        it('rejects empty username via @IsNotEmpty (runs before @MinLength)', async () => {
            const dto = plainToInstance(RegisterDto, { ...valid, username: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'username').isNotEmpty).toBeDefined();
        });

        it('rejects an invalid email format via @IsEmail', async () => {
            const dto = plainToInstance(RegisterDto, { ...valid, email: 'not-an-email' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });

        it('rejects password shorter than 6 chars via @MinLength(6)', async () => {
            const dto = plainToInstance(RegisterDto, { ...valid, password: 'a1bc' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'password').minLength).toBeDefined();
        });

        it('rejects password starting with `.` via @Matches', async () => {
            // The regex `^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$` rejects leading `.` and `\n`.
            const dto = plainToInstance(RegisterDto, { ...valid, password: '.password1' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'password').matches).toBe(
                'Password must contain at least 1 lowercase letter and 1 number or special character',
            );
        });

        it('rejects an all-uppercase password (no lowercase letter)', async () => {
            const dto = plainToInstance(RegisterDto, { ...valid, password: 'ALLUPPER1' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'password').matches).toBeDefined();
        });

        it('accepts a 6-char password (boundary — not 7)', async () => {
            // @MinLength(6) accepts exactly 6.
            const dto = plainToInstance(RegisterDto, { ...valid, password: 'abc1de' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string emailVerificationCallbackUrl via @IsString', async () => {
            const dto = plainToInstance(RegisterDto, {
                ...valid,
                emailVerificationCallbackUrl: 123 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'emailVerificationCallbackUrl').isString).toBeDefined();
        });
    });

    describe('LoginDto', () => {
        it('accepts valid credentials', async () => {
            const dto = plainToInstance(LoginDto, {
                email: 'john@example.com',
                password: 'anything',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects an invalid email', async () => {
            const dto = plainToInstance(LoginDto, { email: 'nope', password: 'anything' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });

        it('rejects empty password via @IsNotEmpty', async () => {
            const dto = plainToInstance(LoginDto, { email: 'a@b.com', password: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'password').isNotEmpty).toBeDefined();
        });

        it('does NOT enforce a min-length on the password (lookup-only at this layer)', async () => {
            // Pinned: login flow MUST accept ANY length non-empty password — the auth provider
            // decides validity. A future MinLength on LoginDto would silently lock out users
            // whose existing password is shorter than the new requirement.
            const dto = plainToInstance(LoginDto, { email: 'a@b.com', password: 'x' });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('UpdatePasswordDto', () => {
        const valid = { currentPassword: 'oldpass1', newPassword: 'newpass1' };

        it('accepts valid current+new pair', async () => {
            const dto = plainToInstance(UpdatePasswordDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects newPassword shorter than 8 chars (stricter than RegisterDto which is 6)', async () => {
            // Pinned: UpdatePasswordDto enforces 8 chars while RegisterDto accepts 6.
            // The asymmetry is intentional — registration is a lower bar; password rotation
            // is an opportunity to upgrade to the modern minimum.
            const dto = plainToInstance(UpdatePasswordDto, { ...valid, newPassword: 'pass1ab' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'newPassword').minLength).toBeDefined();
        });

        it('rejects newPassword that fails the @Matches regex', async () => {
            const dto = plainToInstance(UpdatePasswordDto, {
                ...valid,
                newPassword: '.startdot',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'newPassword').matches).toBe(
                'Password must contain at least 1 lowercase letter and 1 number or special character',
            );
        });

        it('rejects empty currentPassword via @IsNotEmpty', async () => {
            const dto = plainToInstance(UpdatePasswordDto, { ...valid, currentPassword: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'currentPassword').isNotEmpty).toBeDefined();
        });

        it('does NOT validate that currentPassword and newPassword differ (server-side concern)', async () => {
            // Pinned: same-value reuse is the auth-provider's call (`bcrypt.compare`-driven).
            // The DTO layer does not prevent it; pinned so a future "they must differ" rule
            // becomes a deliberate change.
            const dto = plainToInstance(UpdatePasswordDto, {
                currentPassword: 'samepass1',
                newPassword: 'samepass1',
            });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('OAuthCallbackDto', () => {
        it('accepts a code without state', async () => {
            const dto = plainToInstance(OAuthCallbackDto, { code: 'abc123' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a code with state', async () => {
            const dto = plainToInstance(OAuthCallbackDto, { code: 'abc123', state: 'xyz' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty/missing code via @IsNotEmpty', async () => {
            const dto = plainToInstance(OAuthCallbackDto, { code: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'code').isNotEmpty).toBeDefined();
        });

        it('rejects non-string state via @IsString', async () => {
            const dto = plainToInstance(OAuthCallbackDto, {
                code: 'abc',
                state: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'state').isString).toBeDefined();
        });
    });

    describe('VerifyEmailDto', () => {
        it('accepts a non-empty token string', async () => {
            const dto = plainToInstance(VerifyEmailDto, { token: 'tok-1' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty token via @IsNotEmpty', async () => {
            const dto = plainToInstance(VerifyEmailDto, { token: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'token').isNotEmpty).toBeDefined();
        });

        it('rejects non-string token via @IsString', async () => {
            const dto = plainToInstance(VerifyEmailDto, { token: 42 as unknown as string });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'token').isString).toBeDefined();
        });
    });

    describe('ResendVerificationDto', () => {
        it('accepts a valid email', async () => {
            const dto = plainToInstance(ResendVerificationDto, { email: 'a@b.com' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects an invalid email format', async () => {
            const dto = plainToInstance(ResendVerificationDto, { email: 'nope' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });

        it('rejects empty email via @IsNotEmpty', async () => {
            const dto = plainToInstance(ResendVerificationDto, { email: '' });
            const errs = await validate(dto);
            // class-validator chains both — assert isEmail is the operative failure.
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });
    });

    describe('ForgotPasswordDto', () => {
        it('accepts a valid email without callback URL', async () => {
            const dto = plainToInstance(ForgotPasswordDto, { email: 'a@b.com' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a valid email + resetPasswordCallbackUrl', async () => {
            const dto = plainToInstance(ForgotPasswordDto, {
                email: 'a@b.com',
                resetPasswordCallbackUrl: 'https://example.com/reset',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string resetPasswordCallbackUrl via @IsString', async () => {
            const dto = plainToInstance(ForgotPasswordDto, {
                email: 'a@b.com',
                resetPasswordCallbackUrl: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'resetPasswordCallbackUrl').isString).toBeDefined();
        });

        it('rejects an invalid email format', async () => {
            const dto = plainToInstance(ForgotPasswordDto, { email: 'nope' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });
    });

    describe('ResetPasswordDto', () => {
        const valid = { token: 'tok-1', newPassword: 'newpass1' };

        it('accepts a valid token + newPassword pair', async () => {
            const dto = plainToInstance(ResetPasswordDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty token via @IsNotEmpty', async () => {
            const dto = plainToInstance(ResetPasswordDto, { ...valid, token: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'token').isNotEmpty).toBeDefined();
        });

        it('rejects newPassword shorter than 8 chars (matches UpdatePasswordDto policy)', async () => {
            const dto = plainToInstance(ResetPasswordDto, { ...valid, newPassword: 'pass1ab' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'newPassword').minLength).toBeDefined();
        });

        it('rejects newPassword with leading dot via @Matches', async () => {
            const dto = plainToInstance(ResetPasswordDto, { ...valid, newPassword: '.dotstart1' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'newPassword').matches).toBeDefined();
        });
    });

    describe('UpdateProfileDto', () => {
        it('accepts an empty payload (every field is optional)', async () => {
            const dto = plainToInstance(UpdateProfileDto, {});
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully populated payload', async () => {
            const dto = plainToInstance(UpdateProfileDto, {
                username: 'jane',
                avatar: 'https://example.com/jane.png',
                committerName: 'Jane Doe',
                committerEmail: 'jane@example.com',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects username shorter than 3 chars via @MinLength(3)', async () => {
            const dto = plainToInstance(UpdateProfileDto, { username: 'ab' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'username').minLength).toBeDefined();
        });

        it('rejects an invalid avatar URL via @IsUrl', async () => {
            const dto = plainToInstance(UpdateProfileDto, { avatar: 'not-a-url' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'avatar').isUrl).toBeDefined();
        });

        it('rejects an invalid committerEmail via @IsEmail', async () => {
            const dto = plainToInstance(UpdateProfileDto, { committerEmail: 'not-an-email' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'committerEmail').isEmail).toBeDefined();
        });

        it('accepts null committerEmail because @IsOptional short-circuits for nullish values', async () => {
            // Pinned: the DTO type is `string | null`, and @IsOptional() (NOT
            // @ValidateIf((_, v) => v !== undefined)) short-circuits for both
            // `null` and `undefined`. This means callers CAN clear `committerEmail`
            // by sending an explicit `null`, and the auth service is responsible
            // for downstream null-handling. A future swap to @ValidateIf would
            // start failing this test by surfacing an isEmail error.
            const dto = plainToInstance(UpdateProfileDto, { committerEmail: null });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts null committerName because @IsOptional short-circuits the @IsString check', async () => {
            const dto = plainToInstance(UpdateProfileDto, { committerName: null });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string committerName via @IsString', async () => {
            const dto = plainToInstance(UpdateProfileDto, { committerName: 42 as never });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'committerName').isString).toBeDefined();
        });
    });

    describe('CreateApiKeyDto', () => {
        it('accepts a valid name without expiresAt', async () => {
            const dto = plainToInstance(CreateApiKeyDto, { name: 'My CI key' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a valid name + ISO 8601 expiresAt', async () => {
            const dto = plainToInstance(CreateApiKeyDto, {
                name: 'My CI key',
                expiresAt: '2027-01-01T00:00:00.000Z',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty name via @IsNotEmpty', async () => {
            const dto = plainToInstance(CreateApiKeyDto, { name: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'name').isNotEmpty).toBeDefined();
        });

        it('rejects name longer than 100 chars via @MaxLength(100)', async () => {
            const dto = plainToInstance(CreateApiKeyDto, { name: 'a'.repeat(101) });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'name').maxLength).toBeDefined();
        });

        it('accepts exactly 100-char name (boundary)', async () => {
            const dto = plainToInstance(CreateApiKeyDto, { name: 'a'.repeat(100) });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-ISO expiresAt via @IsDateString', async () => {
            const dto = plainToInstance(CreateApiKeyDto, {
                name: 'k',
                expiresAt: '2027/01/01',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'expiresAt').isDateString).toBeDefined();
        });

        it('does NOT validate that expiresAt is in the future (service-layer concern)', async () => {
            // Pinned: the past-vs-future check lives in `ApiKeyService.createKey` so the
            // DTO accepts any well-formed date string. Future-checking at the DTO layer
            // would be an over-tightening of the validator and break the existing
            // service-level "expiresAt in the past" rejection test path.
            const dto = plainToInstance(CreateApiKeyDto, {
                name: 'k',
                expiresAt: '2000-01-01T00:00:00.000Z',
            });
            expect(await validate(dto)).toHaveLength(0);
        });
    });
});
