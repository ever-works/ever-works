import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsEnum,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
    ValidateNested,
} from 'class-validator';
import type {
    RepoConnectionCredentialMode,
    RepoConnectionProvider,
} from '@ever-works/agent/entities';

export const REPO_CONNECTION_PROVIDERS = ['github', 'git'] as const;
export const REPO_CONNECTION_CREDENTIAL_MODES = ['inherit', 'github-app', 'secret-ref'] as const;

/**
 * One seed env file. Content byte caps (≤ 32KB each, ≤ 8 files) are
 * enforced in `RepoRegistryService.assertValidEnvFiles`; the DTO pins
 * the shape and a generous string ceiling so a hostile payload cannot
 * balloon past the JSON body limit before the service check runs.
 */
export class RepoConnectionEnvFileDto {
    @ApiProperty({ maxLength: 200, example: '.env' })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    path: string;

    @ApiProperty({ description: 'File content (≤ 32KB UTF-8).' })
    @IsString()
    @MaxLength(64 * 1024)
    content: string;
}

export class CreateRepoConnectionDto {
    @ApiProperty({ maxLength: 120, example: 'my-service' })
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name: string;

    @ApiProperty({ maxLength: 512, example: 'https://github.com/acme/my-service' })
    @IsString()
    @MinLength(1)
    @MaxLength(512)
    url: string;

    @ApiPropertyOptional({ enum: REPO_CONNECTION_PROVIDERS, default: 'github' })
    @IsOptional()
    @IsEnum(REPO_CONNECTION_PROVIDERS)
    provider?: RepoConnectionProvider;

    @ApiPropertyOptional({ maxLength: 120, example: 'main' })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    defaultBranch?: string;

    @ApiPropertyOptional({
        maxLength: 200,
        description: 'Workspace mount directory (single path segment). Defaults to the name.',
    })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9._-]{1,200}$/, {
        message: 'mountPath must be a single directory name (letters, digits, ".", "_", "-")',
    })
    mountPath?: string;

    @ApiPropertyOptional({ maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @ApiPropertyOptional({ enum: REPO_CONNECTION_CREDENTIAL_MODES, default: 'inherit' })
    @IsOptional()
    @IsEnum(REPO_CONNECTION_CREDENTIAL_MODES)
    credentialMode?: RepoConnectionCredentialMode;

    @ApiPropertyOptional({
        maxLength: 200,
        description:
            'Credential POINTER — "env:NAME", "plugin:github", or a GitHub App installation id. Never a raw token.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    credentialRef?: string;

    @ApiPropertyOptional({ type: [RepoConnectionEnvFileDto], maxItems: 8 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(8)
    @ValidateNested({ each: true })
    @Type(() => RepoConnectionEnvFileDto)
    envFiles?: RepoConnectionEnvFileDto[];

    @ApiPropertyOptional({ default: true })
    @IsOptional()
    @IsBoolean()
    availableInAllProjects?: boolean;

    @ApiPropertyOptional({ default: true })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}

export class UpdateRepoConnectionDto {
    @ApiPropertyOptional({ maxLength: 120 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @ApiPropertyOptional({ maxLength: 512 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(512)
    url?: string;

    @ApiPropertyOptional({ enum: REPO_CONNECTION_PROVIDERS })
    @IsOptional()
    @IsEnum(REPO_CONNECTION_PROVIDERS)
    provider?: RepoConnectionProvider;

    @ApiPropertyOptional({ maxLength: 120 })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    defaultBranch?: string;

    @ApiPropertyOptional({ maxLength: 200 })
    @IsOptional()
    @IsString()
    @Matches(/^[A-Za-z0-9._-]{1,200}$/, {
        message: 'mountPath must be a single directory name (letters, digits, ".", "_", "-")',
    })
    mountPath?: string;

    @ApiPropertyOptional({ maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @ApiPropertyOptional({ enum: REPO_CONNECTION_CREDENTIAL_MODES })
    @IsOptional()
    @IsEnum(REPO_CONNECTION_CREDENTIAL_MODES)
    credentialMode?: RepoConnectionCredentialMode;

    @ApiPropertyOptional({ maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    credentialRef?: string;

    @ApiPropertyOptional({ type: [RepoConnectionEnvFileDto], maxItems: 8 })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(8)
    @ValidateNested({ each: true })
    @Type(() => RepoConnectionEnvFileDto)
    envFiles?: RepoConnectionEnvFileDto[];

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    availableInAllProjects?: boolean;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}

export class ListRepoConnectionsQueryDto {
    @ApiPropertyOptional({
        description: 'When "true", append computed read-only Work-derived entries.',
    })
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true')
    @IsBoolean()
    includeDerived?: boolean;
}

export class SetRepoConnectionEnvFilesDto {
    @ApiProperty({ type: [RepoConnectionEnvFileDto], maxItems: 8 })
    @IsArray()
    @ArrayMaxSize(8)
    @ValidateNested({ each: true })
    @Type(() => RepoConnectionEnvFileDto)
    files: RepoConnectionEnvFileDto[];
}

export class SetAgentRepoAttachmentDto {
    @ApiProperty({ description: 'Whether the attachment is active for the agent.' })
    @IsBoolean()
    enabled: boolean;
}
