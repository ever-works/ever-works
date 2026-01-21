import { IsString, IsOptional, IsNumber, IsBoolean, IsUrl, Min, Max, IsIn } from 'class-validator';

export class ValidateCredentialsDto {
    @IsString()
    accessKey: string;
}

export class CaptureScreenshotDto {
    @IsUrl()
    url: string;

    @IsOptional()
    @IsNumber()
    @Min(320)
    @Max(3840)
    viewportWidth?: number;

    @IsOptional()
    @IsNumber()
    @Min(240)
    @Max(2160)
    viewportHeight?: number;

    @IsOptional()
    @IsIn(['png', 'jpg', 'webp'])
    format?: 'png' | 'jpg' | 'webp';

    @IsOptional()
    @IsBoolean()
    fullPage?: boolean;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(10000)
    delay?: number;

    @IsOptional()
    @IsBoolean()
    blockAds?: boolean;

    @IsOptional()
    @IsBoolean()
    blockTrackers?: boolean;

    @IsOptional()
    @IsBoolean()
    blockCookieBanners?: boolean;
}

export class GetScreenshotUrlDto extends CaptureScreenshotDto {}
