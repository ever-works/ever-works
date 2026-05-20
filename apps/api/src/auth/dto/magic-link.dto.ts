import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestMagicLinkDto {
    @ApiProperty({
        description:
            'Email to send the magic link to. The response is identical regardless of whether the email exists — clients cannot use this endpoint to enumerate users.',
        example: 'user@example.com',
    })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiPropertyOptional({
        description:
            'Optional callback URL to embed the token into. Must resolve to an allow-listed host (see ALLOWED_CALLBACK_HOSTS). Falls back to the platform default when omitted.',
    })
    @IsString()
    @IsOptional()
    magicLinkCallbackUrl?: string;
}

export class RedeemMagicLinkDto {
    @ApiProperty({
        description: 'The magic-link token delivered to the user via email.',
    })
    @IsString()
    @IsNotEmpty()
    token: string;
}
