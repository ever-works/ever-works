import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';

export class VerifyEmailDto {
    @IsString()
    @IsNotEmpty()
    token: string;
}

export class ResendVerificationDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;
}

export class ForgotPasswordDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsString()
    @IsOptional()
    resetPasswordCallbackUrl?: string;
}

export class ResetPasswordDto {
    @IsString()
    @IsNotEmpty()
    token: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
    })
    newPassword: string;
}
