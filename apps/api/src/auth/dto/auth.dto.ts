import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
    @ApiProperty({ description: 'Username for the new account', example: 'johndoe', minLength: 3 })
    @IsNotEmpty()
    @IsString()
    @MinLength(3)
    username: string;

    @ApiProperty({ description: 'Email address', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    // H-02: regex previously was /^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, which
    // looked like "lowercase + digit/special" but `\w` includes letters so
    // the second lookahead is satisfied by any letter. "abcdef" passed at
    // length 6. Use explicit lowercase + (digit or non-word) lookaheads,
    // and raise the global minimum to 8 to match Better Auth's runtime
    // setting (auth-runtime.instance.ts).
    @ApiProperty({
        description:
            'Password (min 8 chars, must contain lowercase letter and number or special char)',
        example: 'MySecure123!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/, {
        message:
            'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character',
    })
    password: string;

    @ApiPropertyOptional({ description: 'Callback URL for email verification redirect' })
    @IsString()
    @IsOptional()
    emailVerificationCallbackUrl?: string;
}

export class LoginDto {
    @ApiProperty({ description: 'Email address', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({ description: 'Account password', example: 'MySecure123!' })
    @IsString()
    @IsNotEmpty()
    password: string;
}

export class UpdatePasswordDto {
    @ApiProperty({ description: 'Current password for verification', example: 'OldPassword123!' })
    @IsString()
    @IsNotEmpty()
    currentPassword: string;

    @ApiProperty({
        description:
            'New password (min 8 chars, must contain lowercase letter and number or special char)',
        example: 'NewSecure456!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/, {
        message:
            'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character',
    })
    newPassword: string;
}

/**
 * EW-617 G3: payload for `POST /api/auth/claim`. Anonymous users send
 * this with their anon session bearer token to convert into a regular
 * account; reuses the same password rules as `RegisterDto`.
 */
export class ClaimAccountDto {
    @ApiProperty({ description: 'Email address to attach', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({
        description:
            'Password (min 8 chars, must contain lowercase letter and number or special char)',
        example: 'MySecure123!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/, {
        message:
            'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character',
    })
    password: string;

    @ApiPropertyOptional({
        description: 'Username to use after claim (defaults to current anon username)',
    })
    @IsString()
    @IsOptional()
    @MinLength(3)
    username?: string;

    @ApiPropertyOptional({ description: 'Callback URL for email verification redirect' })
    @IsString()
    @IsOptional()
    emailVerificationCallbackUrl?: string;

    @ApiPropertyOptional({
        description:
            'Optional UUID v4 minted at funnel entry (landing page → wizard). Threaded into the zero-friction telemetry funnel; ignored when absent.',
    })
    @IsString()
    @IsOptional()
    correlationId?: string;
}

export class OAuthCallbackDto {
    @ApiProperty({ description: 'Authorization code from OAuth provider' })
    @IsString()
    @IsNotEmpty()
    code: string;

    @ApiPropertyOptional({ description: 'State parameter for CSRF protection' })
    @IsString()
    @IsOptional()
    state?: string;
}
