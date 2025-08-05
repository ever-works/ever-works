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
    @Matches(/((?=.\d)|(?=.\W+))(?![.\n])(?=.[a-z]).$/, {
        message: 'Password must contain at least letter, and 1 number or special character',
    })
    newPassword: string;
}
