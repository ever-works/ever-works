import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsEmail,
    IsObject,
    IsOptional,
    IsString,
    Length,
    Matches,
    MaxLength,
} from 'class-validator';
import type {
    OnboardingStatus,
    RegisterWorkErrorBody,
    RegisterWorkErrorCode,
    RegisterWorkResponse,
} from '@ever-works/contracts/api';

const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const GITHUB_HTTPS_REPO = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i;
const HTTPS_URL = /^https?:\/\/.+/i;

export class RegisterWorkRequestDto {
    @ApiProperty({
        description: 'HTTPS GitHub URL of the manifest repo (must contain works.yml at root).',
        example: 'https://github.com/octocat/awesome-mcp',
    })
    @IsString()
    @MaxLength(512)
    @Matches(GITHUB_HTTPS_REPO, { message: 'repo must be a https://github.com/<owner>/<repo> URL' })
    repo!: string;

    @ApiPropertyOptional({ description: 'Optional contact email.' })
    @IsOptional()
    @IsEmail()
    email?: string;

    @ApiPropertyOptional({
        description: 'Optional opaque agent identifier (printable ASCII, ≤256 chars).',
    })
    @IsOptional()
    @IsString()
    @Length(1, 256)
    @Matches(PRINTABLE_ASCII, { message: 'agentId must be printable ASCII' })
    agentId?: string;

    @ApiPropertyOptional({
        description: 'Optional HTTPS URL for signed terminal-status webhooks.',
        example: 'https://my-agent.example.com/webhooks/ever-works',
    })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    @Matches(HTTPS_URL, { message: 'webhookUrl must be an http(s) URL' })
    webhookUrl?: string;

    @ApiPropertyOptional({ description: 'DNS-safe slug requested for the assigned subdomain.' })
    @IsOptional()
    @IsString()
    @Length(3, 63)
    @Matches(SUBDOMAIN, { message: 'subdomain must be DNS-safe (lowercase, hyphens)' })
    subdomain?: string;

    @ApiPropertyOptional({
        description:
            'Reserved for v2 paid plane (x402 / Skyfire / Crossmint / Stripe Agent). Ignored at v1.',
    })
    @IsOptional()
    @IsObject()
    agentPayment?: Record<string, unknown>;
}

export class RegisterWorkResponseDto implements RegisterWorkResponse {
    @ApiProperty() onboardingId!: string;
    @ApiProperty() workId!: string;
    @ApiProperty({
        enum: [
            'received',
            'validating',
            'validated',
            'queued',
            'generating',
            'deployed',
            'failed',
            'rejected',
        ],
    })
    status!: OnboardingStatus;
    @ApiProperty() statusUrl!: string;
    @ApiProperty() subdomain!: string;
    @ApiPropertyOptional() deploymentUrl?: string;
    @ApiPropertyOptional({ type: [String] }) warnings?: string[];
}

export class RegisterWorkErrorDto implements RegisterWorkErrorBody {
    @ApiProperty() statusCode!: number;
    @ApiProperty({
        enum: [
            'validation_error',
            'gh_repo_access_denied',
            'gh_credential_invalid',
            'gh_insufficient_scope_for_repo_creation',
            'manifest_missing',
            'manifest_invalid',
            'unsupported_capability',
            'repo_already_owned',
            'subdomain_taken',
            'rate_limited',
            'internal_error',
        ],
    })
    code!: RegisterWorkErrorCode;
    @ApiProperty() message!: string;
    @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
    errors?: ReadonlyArray<{ path: string; message: string; subcode?: string }>;
}
