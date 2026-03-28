import { IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
