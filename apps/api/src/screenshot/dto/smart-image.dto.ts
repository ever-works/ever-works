import {
    IsString,
    IsOptional,
    IsUrl,
    IsIn,
    IsArray,
    ValidateNested,
    ArrayMinSize,
    ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SmartImagePreviewDto {
    @IsUrl()
    url: string;

    @IsOptional()
    @IsIn(['software', 'ecommerce', 'services', 'general'])
    domainType?: string;

    @IsOptional()
    @IsString()
    itemName?: string;
}

export class SmartImagePreviewResponseDto {
    status: 'success' | 'error';
    primaryImage: string | null;
    source: 'screenshot' | 'scraped';
    confidence?: number;
    error?: string;
}

export class BulkCaptureItemDto {
    @IsString()
    itemSlug: string;

    @IsUrl()
    sourceUrl: string;

    @IsOptional()
    @IsString()
    itemName?: string;
}

export class BulkCaptureImagesDto {
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    itemSlugs?: string[];

    @IsIn(['missing', 'all'])
    mode: 'missing' | 'all';

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BulkCaptureItemDto)
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    items?: BulkCaptureItemDto[];
}

export class BulkCaptureResultDto {
    itemSlug?: string;
    itemName?: string;
    primaryImage: string | null;
    source: 'screenshot' | 'scraped';
    confidence?: number;
    error?: string;
}

export class BulkCaptureImagesResponseDto {
    status: 'success' | 'partial' | 'error';
    results: BulkCaptureResultDto[];
    totalProcessed: number;
    successCount: number;
    errorCount: number;
    message?: string;
}

export class UpdateDomainTypeDto {
    @IsIn(['software', 'ecommerce', 'services', 'general'])
    domainType: string;

    @IsOptional()
    manuallySet?: boolean;
}

export class UpdateDomainTypeResponseDto {
    status: 'success' | 'error';
    domainType: string;
    domainTypeConfidence?: number;
    domainTypeManuallySet: boolean;
    message?: string;
}
