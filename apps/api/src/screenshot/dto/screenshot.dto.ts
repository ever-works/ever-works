import { IsString, IsOptional, IsNumber, IsBoolean, IsUrl, Min, Max, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export * from './smart-image.dto';

export class ValidateCredentialsDto {
    @ApiProperty({ description: 'ScreenshotOne API access key' })
    @IsString()
    accessKey: string;

    @ApiPropertyOptional({ description: 'ScreenshotOne API secret key (optional for signed URLs)' })
    @IsOptional()
    @IsString()
    secretKey?: string;
}

export class CaptureScreenshotDto {
    @ApiProperty({ description: 'URL of the page to capture', example: 'https://example.com' })
    @IsUrl()
    url: string;

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
