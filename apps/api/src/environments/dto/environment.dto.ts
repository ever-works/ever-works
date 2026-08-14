import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';

/**
 * Environments (Settings → Environments) — request DTOs.
 *
 * The package-spec / host patterns below mirror the canonical allow-list
 * validators in `@ever-works/plugin` (`runtime-environment.ts`), which
 * `EnvironmentsService` re-applies (defense in depth) and the
 * claude-managed-agent plugin applies a third time before composing
 * install commands. Strict allow-lists on purpose: every shell
 * metacharacter (whitespace, `;|&$` backticks, quotes, braces,
 * redirects) is outside the accepted alphabet, and a leading `-` (flag
 * injection) is impossible because the first character must be
 * alphanumeric (or `@` for a scoped npm name).
 */

const PIP_PACKAGE_SPEC_PATTERN =
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?(?:(?:===|==|>=|<=|~=|!=|>|<)[0-9][A-Za-z0-9.*+!-]*(?:,(?:===|==|>=|<=|~=|!=|>|<)[0-9][A-Za-z0-9.*+!-]*)*)?$/;

const NPM_PACKAGE_SPEC_PATTERN =
    /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@(?:[A-Za-z0-9][A-Za-z0-9.*+x-]*|[~^<>=]{1,2}[0-9][A-Za-z0-9.*+x.-]*))?$/;

const ALLOWED_HOST_PATTERN =
    /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

export class CreateEnvironmentDto {
    @ApiProperty({ minLength: 1, maxLength: 120 })
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    @IsNotEmpty()
    name: string;

    @ApiProperty({ required: false, maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    @ApiProperty({
        required: false,
        type: [String],
        description: 'pip requirement specifiers, e.g. "requests", "pandas==2.2.0".',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(128, { each: true })
    @Matches(PIP_PACKAGE_SPEC_PATTERN, {
        each: true,
        message: 'each pipPackages entry must be a plain pip requirement specifier',
    })
    pipPackages?: string[];

    @ApiProperty({
        required: false,
        type: [String],
        description: 'npm install targets, e.g. "typescript", "@scope/pkg@^1.2.0".',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(128, { each: true })
    @Matches(NPM_PACKAGE_SPEC_PATTERN, {
        each: true,
        message: 'each npmPackages entry must be a plain npm package spec',
    })
    npmPackages?: string[];

    @ApiProperty({ required: false, enum: ['unrestricted', 'limited'] })
    @IsOptional()
    @IsIn(['unrestricted', 'limited'])
    networkingMode?: 'unrestricted' | 'limited';

    @ApiProperty({
        required: false,
        type: [String],
        description:
            'Egress allow-list (hostnames, optional single leading "*." wildcard). Only used when networkingMode is "limited".',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(253, { each: true })
    @Matches(ALLOWED_HOST_PATTERN, {
        each: true,
        message: 'each allowedHosts entry must be a hostname (optional "*." wildcard)',
    })
    allowedHosts?: string[];

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    allowPackageManagers?: boolean;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    availableInAllProjects?: boolean;
}

export class UpdateEnvironmentDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 2000 })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string | null;

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(128, { each: true })
    @Matches(PIP_PACKAGE_SPEC_PATTERN, {
        each: true,
        message: 'each pipPackages entry must be a plain pip requirement specifier',
    })
    pipPackages?: string[];

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(128, { each: true })
    @Matches(NPM_PACKAGE_SPEC_PATTERN, {
        each: true,
        message: 'each npmPackages entry must be a plain npm package spec',
    })
    npmPackages?: string[];

    @ApiProperty({ required: false, enum: ['unrestricted', 'limited'] })
    @IsOptional()
    @IsIn(['unrestricted', 'limited'])
    networkingMode?: 'unrestricted' | 'limited';

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(200)
    @IsString({ each: true })
    @MaxLength(253, { each: true })
    @Matches(ALLOWED_HOST_PATTERN, {
        each: true,
        message: 'each allowedHosts entry must be a hostname (optional "*." wildcard)',
    })
    allowedHosts?: string[];

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    allowPackageManagers?: boolean;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    availableInAllProjects?: boolean;
}

export class ListEnvironmentsQueryDto {
    @ApiProperty({ required: false, enum: ['draft', 'published'] })
    @IsOptional()
    @IsIn(['draft', 'published'])
    status?: 'draft' | 'published';
}
