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

    @ApiProperty({
        description:
            'Password (min 6 chars, must contain lowercase letter and number/special char)',
        example: 'MySecure123!',
        minLength: 6,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(6)
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
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
            'New password (min 8 chars, must contain lowercase letter and number/special char)',
        example: 'NewSecure456!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
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
            'Password (min 6 chars, must contain lowercase letter and number/special char)',
        example: 'MySecure123!',
        minLength: 6,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(6)
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
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
