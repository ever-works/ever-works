import {
    IsString,
    IsOptional,
    IsUrl,
    IsArray,
    IsUUID,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ExtractItemDetailsDto as IExtractItemDetailsDto } from '@ever-works/contracts/api';
import { isSafeWebhookUrl } from '../../utils/ssrf-guard';

// Security (SSRF): `@IsUrl` only enforces http(s) + a TLD, so it still accepts
// URLs whose host is a literal private/loopback/link-local IP (e.g.
// http://169.254.169.254/... AWS/GCP/Azure IMDS) or a cloud-metadata hostname
// (metadata.google.internal). `source_url` is later fetched server-side by the
// content-extractor / screenshot facades, so reject those hosts at the DTO
// boundary too — a lexical mirror of the guard `WorkGenerationService` already
// applies before fetching. Public URLs are unaffected; full DNS-rebinding
// defense still lives in the fetching plugins.
@ValidatorConstraint({ name: 'isNotSsrfUrl', async: false })
class IsNotSsrfUrlConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return typeof value === 'string' && isSafeWebhookUrl(value);
    }

    defaultMessage(): string {
        return 'source_url is not allowed';
    }
}

export class ExtractItemDetailsDto implements IExtractItemDetailsDto {
    @ApiProperty({
        description: 'URL to extract item details from',
        example: 'https://example.com',
    })
    @IsString()
    @IsUrl({ protocols: ['http', 'https'], require_tld: true })
    // Security (SSRF): block private/loopback/link-local IP literals and
    // cloud-metadata hostnames that pass @IsUrl but must never be fetched.
    @Validate(IsNotSsrfUrlConstraint)
    source_url: string;

    @ApiPropertyOptional({
        description: 'Optional work context for provider resolution and usage attribution',
        example: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
    })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiPropertyOptional({ description: 'Existing categories to match against', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    existing_categories?: string[];
}
