import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * M-06: payload validator for `POST /api/auth/anonymous`. Previously typed
 * inline (`{ captchaToken?: string; correlationId?: string }`) so the global
 * `ValidationPipe { forbidNonWhitelisted: true }` had no DTO to enforce
 * against — any extra keys silently flowed through, and `correlationId`
 * landed verbatim in PostHog with no length/shape check.
 */
export class CreateAnonymousDto {
    @ApiPropertyOptional({
        description:
            'Captcha token from the configured provider (Turnstile / hCaptcha / reCAPTCHA)',
    })
    @IsOptional()
    @IsString()
    @MaxLength(4096)
    captchaToken?: string;

    @ApiPropertyOptional({
        description:
            'UUID minted client-side at the start of the zero-friction funnel. Used to stitch funnel events together in PostHog.',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID('4')
    correlationId?: string;
}
