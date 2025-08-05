import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';

export class RegisterDto {
    @IsNotEmpty()
    @IsString()
    @MinLength(3)
    username: string;

    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(6)
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
    })
    password: string;

    @IsString()
    @IsOptional()
    emailverificationcallbackurl?: string;
}

export class LoginDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsString()
    @IsNotEmpty()
    password: string;
}

export class RefreshTokenDto {
    @IsString()
    @IsNotEmpty()
    refreshToken: string;
}

export class UpdatePasswordDto {
    @IsString()
    @IsNotEmpty()
    currentPassword: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, {
        message:
            'Password must contain at least 1 lowercase letter and 1 number or special character',
    })
    newPassword: string;
}

export class OAuthCallbackDto {
    @IsString()
    @IsNotEmpty()
    code: string;

    @IsString()
    @IsOptional()
    state?: string;
}
