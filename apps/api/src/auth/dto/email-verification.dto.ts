import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyEmailDto {
    @ApiProperty({ description: 'Email verification token from the verification email' })
    @IsString()
    @IsNotEmpty()
    token: string;
}

/**
 * EW-070 — body of the SIGNED-OUT verification resend.
 *
 * The class existed since the first auth commit but nothing ever imported it:
 * there was no public resend route, so a user whose verification mail never
 * arrived had no way back in (login 403s, and the authenticated
 * `POST /auth/send-verification` needs the session they cannot get).
 */
export class ResendVerificationDto {
    @ApiProperty({
        description: 'Email address to resend verification to',
        example: 'john@example.com',
    })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiPropertyOptional({
        description:
            'Callback URL the verification link should point at. Host-validated against ALLOWED_CALLBACK_HOSTS; anything else falls back to the platform default.',
    })
    @IsString()
    @IsOptional()
    emailVerificationCallbackUrl?: string;
}

export class ForgotPasswordDto {
    @ApiProperty({ description: 'Email address for password reset', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiPropertyOptional({ description: 'Callback URL for password reset redirect' })
    @IsString()
    @IsOptional()
    resetPasswordCallbackUrl?: string;
}

export class ResetPasswordDto {
    @ApiProperty({ description: 'Password reset token from the reset email' })
    @IsString()
    @IsNotEmpty()
    token: string;

    @ApiProperty({
        description:
            'New password (min 8 chars, must contain lowercase letter and number/special char)',
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
