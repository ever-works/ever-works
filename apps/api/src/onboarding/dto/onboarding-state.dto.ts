import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import type {
    OnboardingAiChoice,
    OnboardingDbChoice,
    OnboardingDeployChoice,
    OnboardingStorageChoice,
    OnboardingWizardStateV2,
    OnboardingCatalogResponse,
} from '@ever-works/contracts/api';

const AI_CHOICES: readonly OnboardingAiChoice[] = [
    'ever-works',
    'openrouter',
    'claude-code',
    'codex',
    'gemini',
    'grok',
];

const STORAGE_CHOICES: readonly OnboardingStorageChoice[] = [
    'ever-works-git',
    'user-github',
    'user-gitlab',
    'user-git',
];

const DEPLOY_CHOICES: readonly OnboardingDeployChoice[] = ['ever-works', 'vercel', 'k8s'];

const DB_CHOICES: readonly OnboardingDbChoice[] = ['ever-works-db', 'custom'];

class AiChoicePatchDto {
    @ApiProperty({ enum: AI_CHOICES })
    @IsIn(AI_CHOICES)
    choice!: OnboardingAiChoice;
}

class StorageChoicePatchDto {
    @ApiProperty({ enum: STORAGE_CHOICES })
    @IsIn(STORAGE_CHOICES)
    choice!: OnboardingStorageChoice;
}

class DeployChoicePatchDto {
    @ApiProperty({ enum: DEPLOY_CHOICES })
    @IsIn(DEPLOY_CHOICES)
    choice!: OnboardingDeployChoice;
}

class DbChoicePatchDto {
    @ApiProperty({ enum: DB_CHOICES })
    @IsIn(DB_CHOICES)
    choice!: OnboardingDbChoice;
}

// `OnboardingStatePatchInnerDto` MUST be declared BEFORE
// `OnboardingStatePatchBodyDto`: the latter references it inside a
// `@Type(() => OnboardingStatePatchInnerDto)` decorator. Even though the
// arrow function defers the lookup, SWC's class decorator evaluation
// order trips a TDZ ReferenceError when the decorated outer class is
// instantiated by Nest at startup. ts-jest tolerates it; SWC doesn't.
export class OnboardingStatePatchInnerDto {
    @ApiPropertyOptional({ minimum: 0 })
    @IsOptional()
    @IsInt()
    @Min(0)
    lastStep?: number;

    @ApiPropertyOptional({ type: AiChoicePatchDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => AiChoicePatchDto)
    ai?: AiChoicePatchDto;

    @ApiPropertyOptional({ type: StorageChoicePatchDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => StorageChoicePatchDto)
    storage?: StorageChoicePatchDto;

    @ApiPropertyOptional({ type: DbChoicePatchDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => DbChoicePatchDto)
    db?: DbChoicePatchDto;

    @ApiPropertyOptional({ type: DeployChoicePatchDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => DeployChoicePatchDto)
    deploy?: DeployChoicePatchDto;

    // Security: bound array size and element length to prevent large-payload DoS writes to onboarding_state column
    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    skippedSteps?: string[];

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    pluginsReviewed?: boolean;

    // Security (EW-722): `prompt` is contract-declared on
    // `OnboardingStatePatchRequest` (EW-617 G4 landing-page prompt) but was
    // previously rejected by `forbidNonWhitelisted`. Whitelist it here with
    // the contract's 5000-char bound (same cap as
    // `CreateItemsGeneratorDto.prompt`) so oversized user-controlled text
    // cannot bloat the onboarding_state column.
    @ApiPropertyOptional({ maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    prompt?: string;
}

export class OnboardingStatePatchBodyDto {
    @ApiPropertyOptional({
        description: 'Partial state update. Server deep-merges with persisted version-2 shape.',
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => OnboardingStatePatchInnerDto)
    state?: OnboardingStatePatchInnerDto;
}

export class OnboardingStateResponseDto {
    @ApiProperty({ nullable: true })
    completedAt!: string | null;

    @ApiProperty({ nullable: true })
    dismissedAt!: string | null;

    @ApiProperty()
    state!: OnboardingWizardStateV2;
}

export class OnboardingCatalogResponseDto implements OnboardingCatalogResponse {
    @ApiProperty()
    ai!: OnboardingCatalogResponse['ai'];

    @ApiProperty()
    storage!: OnboardingCatalogResponse['storage'];

    @ApiProperty()
    db!: OnboardingCatalogResponse['db'];

    @ApiProperty()
    deploy!: OnboardingCatalogResponse['deploy'];

    @ApiProperty()
    plugins!: OnboardingCatalogResponse['plugins'];
}

export { AI_CHOICES, STORAGE_CHOICES, DB_CHOICES, DEPLOY_CHOICES };
