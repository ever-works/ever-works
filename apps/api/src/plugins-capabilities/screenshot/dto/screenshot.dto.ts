import {
    IsOptional,
    IsNumber,
    IsBoolean,
    IsUrl,
    Min,
    Max,
    IsIn,
    IsString,
    IsUUID,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isSafeWebhookUrl } from '@ever-works/agent/utils';

// Security (SSRF): `@IsUrl` with no options accepts URLs whose host is a
// literal private/loopback/link-local IP (e.g. http://169.254.169.254 AWS
// IMDS) or a cloud-metadata hostname. The validated URL is forwarded to
// third-party screenshot providers; if those providers follow private-address
// URLs they can leak cloud credentials. Block at the DTO boundary with the
// same lexical guard used by WebhooksService / WorkGenerationService.
@ValidatorConstraint({ name: 'isNotSsrfUrl', async: false })
class IsNotSsrfUrlConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return typeof value === 'string' && isSafeWebhookUrl(value);
    }

    defaultMessage(): string {
        return 'URL is not allowed';
    }
}

export class CaptureScreenshotDto {
    @ApiProperty({ description: 'URL of the page to capture', example: 'https://example.com' })
    // Security: restrict to HTTPS, require a TLD, and block private/loopback/
    // link-local addresses and cloud-metadata hostnames via the SSRF guard.
    @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
    @Validate(IsNotSsrfUrlConstraint)
    url: string;

    @ApiPropertyOptional({
        description: 'Optional provider override',
        example: 'screenshotone',
    })
    @IsOptional()
    @IsString()
    providerOverride?: string;

    @ApiPropertyOptional({
        description: 'Optional work context for provider resolution',
        example: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({
        description: 'Viewport width in pixels',
        example: 1280,
        minimum: 320,
        maximum: 3840,
    })
    @IsOptional()
    @IsNumber()
    @Min(320)
    @Max(3840)
    viewportWidth?: number;

    @ApiPropertyOptional({
        description: 'Viewport height in pixels',
        example: 720,
        minimum: 240,
        maximum: 2160,
    })
    @IsOptional()
    @IsNumber()
    @Min(240)
    @Max(2160)
    viewportHeight?: number;

    @ApiPropertyOptional({
        description: 'Image format',
        enum: ['png', 'jpg', 'webp'],
        default: 'png',
    })
    @IsOptional()
    @IsIn(['png', 'jpg', 'webp'])
    format?: 'png' | 'jpg' | 'webp';

    @ApiPropertyOptional({
        description: 'Capture full page instead of viewport only',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    fullPage?: boolean;

    @ApiPropertyOptional({
        description: 'Delay in ms before capture',
        example: 1000,
        minimum: 0,
        maximum: 10000,
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(10000)
    delay?: number;

    @ApiPropertyOptional({ description: 'Block advertisements', default: false })
    @IsOptional()
    @IsBoolean()
    blockAds?: boolean;

    @ApiPropertyOptional({ description: 'Block tracking scripts', default: false })
    @IsOptional()
    @IsBoolean()
    blockTrackers?: boolean;

    @ApiPropertyOptional({ description: 'Block cookie consent banners', default: false })
    @IsOptional()
    @IsBoolean()
    blockCookieBanners?: boolean;
}

export class GetScreenshotUrlDto extends CaptureScreenshotDto {}
