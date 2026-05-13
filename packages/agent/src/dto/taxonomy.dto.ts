import { Transform } from 'class-transformer';
import { IsString, IsOptional, IsNumber, MaxLength, Min } from 'class-validator';
import { sanitizeName, sanitizeDescription } from '../utils/sanitize.util';

// Category DTOs

/**
 * Hard cap on inline SVG payload size. Sanitized icons should be well
 * under 3KB; the limit gives headroom for legitimate paths while
 * rejecting obvious abuse (megabyte rasterized blobs encoded as data URIs).
 */
const MAX_ICON_SVG_LENGTH = 8000;

export class CreateCategoryDto {
    @IsString()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    icon_url?: string;

    @IsString()
    @IsOptional()
    @MaxLength(MAX_ICON_SVG_LENGTH)
    icon_svg?: string;

    @IsNumber()
    @IsOptional()
    @Min(0)
    priority?: number;
}

export class UpdateCategoryDto {
    @IsString()
    @IsOptional()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    icon_url?: string;

    @IsString()
    @IsOptional()
    @MaxLength(MAX_ICON_SVG_LENGTH)
    icon_svg?: string;

    @IsNumber()
    @IsOptional()
    @Min(0)
    priority?: number;
}

// Collection DTOs

export class CreateCollectionDto {
    @IsString()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    icon_url?: string;

    @IsString()
    @IsOptional()
    @MaxLength(MAX_ICON_SVG_LENGTH)
    icon_svg?: string;

    @IsNumber()
    @IsOptional()
    @Min(0)
    priority?: number;
}

export class UpdateCollectionDto {
    @IsString()
    @IsOptional()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description?: string;

    @IsString()
    @IsOptional()
    @MaxLength(500)
    icon_url?: string;

    @IsString()
    @IsOptional()
    @MaxLength(MAX_ICON_SVG_LENGTH)
    icon_svg?: string;

    @IsNumber()
    @IsOptional()
    @Min(0)
    priority?: number;
}

// Tag DTOs

export class CreateTagDto {
    @IsString()
    @MaxLength(50)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 50) : value))
    name: string;
}

export class UpdateTagDto {
    @IsString()
    @IsOptional()
    @MaxLength(50)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 50) : value))
    name?: string;
}
