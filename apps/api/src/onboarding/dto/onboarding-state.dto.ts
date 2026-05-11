import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
} from 'class-validator';
import type {
    OnboardingAiChoice,
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

export class OnboardingStatePatchBodyDto {
    @ApiPropertyOptional({
        description:
            'Partial state update. Server deep-merges with persisted version-2 shape.',
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => OnboardingStatePatchInnerDto)
    state?: OnboardingStatePatchInnerDto;
}

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

    @ApiPropertyOptional({ type: DeployChoicePatchDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => DeployChoicePatchDto)
    deploy?: DeployChoicePatchDto;

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    skippedSteps?: string[];

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    pluginsReviewed?: boolean;
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
    deploy!: OnboardingCatalogResponse['deploy'];

    @ApiProperty()
    plugins!: OnboardingCatalogResponse['plugins'];
}

export { AI_CHOICES, STORAGE_CHOICES, DEPLOY_CHOICES };
