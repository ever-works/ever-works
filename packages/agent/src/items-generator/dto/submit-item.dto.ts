import {
    IsString,
    IsNotEmpty,
    IsOptional,
    IsBoolean,
    IsUrl,
    IsArray,
    IsInt,
    Min,
    MaxLength,
    ValidateIf,
    ArrayMinSize,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SubmitItemDto as ISubmitItemDto } from '@ever-works/contracts/api';
import { isSafeWebhookUrl } from '../../utils/ssrf-guard';

// Security (SSRF): `@IsUrl` only enforces http(s) + a TLD, so it still accepts
// URLs whose host is a literal private/loopback/link-local IP (e.g.
// http://169.254.169.254/... AWS/GCP/Azure IMDS) or a cloud-metadata hostname
// (metadata.google.internal). `source_url`, `brand_logo_url`, and `images` are
// persisted to the work's YAML and later fetched server-side (content-extractor
// / screenshot / image-capture facades), so reject those hosts at the DTO
// boundary too — a lexical mirror of the guard `WorkGenerationService` already
// applies before fetching. Public URLs are unaffected; full DNS-rebinding
// defense still lives in the fetching plugins. Mirrors `ExtractItemDetailsDto`.
@ValidatorConstraint({ name: 'isNotSsrfUrl', async: false })
class IsNotSsrfUrlConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return typeof value === 'string' && isSafeWebhookUrl(value);
    }

    defaultMessage(): string {
        return 'URL is not allowed';
    }
}

export class SubmitItemDto implements ISubmitItemDto {
    @ApiProperty({ description: 'Name of the item' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ description: 'Description of the item' })
    @IsString()
    @IsNotEmpty()
    description: string;

    @ApiProperty({ description: 'Source URL of the item', example: 'https://example.com' })
    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    // Security (SSRF): block private/loopback/link-local IP literals and
    // cloud-metadata hostnames that pass @IsUrl but must never be fetched.
    @Validate(IsNotSsrfUrlConstraint)
    source_url: string;

    // Backward compatibility: accept single category string
    // Required if categories array is not provided or empty
    @ApiPropertyOptional({
        description: 'Single category (use categories array instead for multiple)',
    })
    @ValidateIf((o) => !Array.isArray(o.categories) || o.categories.length === 0)
    @IsString()
    @IsNotEmpty()
    category?: string;

    @ApiPropertyOptional({ description: 'Categories for the item', type: [String] })
    @ValidateIf((o) => typeof o.category !== 'string' || o.category.length === 0)
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    categories?: string[];

    @ApiPropertyOptional({ description: 'Tags for the item', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @ApiPropertyOptional({ description: 'Whether the item is featured', default: false })
    @IsOptional()
    @IsBoolean()
    featured?: boolean;

    @ApiPropertyOptional({ description: 'Display order (0-based)', minimum: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    order?: number;

    @ApiPropertyOptional({ description: 'Whether to pay and publish immediately' })
    @IsOptional()
    @IsBoolean()
    pay_and_publish_now?: boolean;

    @ApiPropertyOptional({ description: 'Custom URL slug for the item' })
    @IsOptional()
    @IsString()
    slug?: string;

    @ApiPropertyOptional({ description: 'Brand name associated with the item' })
    @IsOptional()
    @IsString()
    brand?: string;

    @ApiPropertyOptional({ description: 'Brand logo URL', example: 'https://example.com/logo.png' })
    @IsOptional()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    // Security (SSRF): brand logo is fetched server-side for optimization/display;
    // block private/loopback/link-local IPs and cloud-metadata hostnames.
    @Validate(IsNotSsrfUrlConstraint)
    brand_logo_url?: string;

    @ApiPropertyOptional({ description: 'Image URLs for the item', type: [String] })
    @IsOptional()
    @IsArray()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true }, { each: true })
    // Security (SSRF): each image URL is fetched server-side; block private/
    // loopback/link-local IPs and cloud-metadata hostnames per-element.
    @Validate(IsNotSsrfUrlConstraint, { each: true })
    images?: string[];

    @ApiPropertyOptional({
        description: 'Whether to create a pull request for this change',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;

    @ApiPropertyOptional({
        description:
            'Long-form markdown body. Stored as `data/<slug>/<slug>.md` and mirrored on the YAML `markdown` field. When omitted, the generator writes a stub body built from name + description + source_url.',
        maxLength: 100000,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100000)
    markdown?: string;
}
