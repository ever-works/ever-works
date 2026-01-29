import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyEmailDto {
    @ApiProperty({ description: 'Email verification token from the verification email' })
    @IsString()
    @IsNotEmpty()
    token: string;
}

export class ResendVerificationDto {
    @ApiProperty({
        description: 'Email address to resend verification to',
        example: 'john@example.com',
    })
    @IsEmail()
    @IsNotEmpty()
    email: string;
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
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
    })
    newPassword: string;
}
