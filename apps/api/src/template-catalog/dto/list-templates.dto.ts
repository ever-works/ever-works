import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

const TEMPLATE_KINDS = ['website', 'work'] as const;

export class ListTemplatesQueryDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';
}

export class AddCustomTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';

    @ApiProperty()
    @IsString()
    @IsUrl({
        protocols: ['http', 'https'],
        require_protocol: true,
    })
    repositoryUrl: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    name?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    description?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    framework?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUrl({
        protocols: ['http', 'https'],
        require_protocol: true,
    })
    previewImageUrl?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    branch?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    betaBranch?: string;
}

export class SetDefaultTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';

    @ApiProperty()
    @IsString()
    templateId: string;
}

export class UpdateCustomTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    name?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    description?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    framework?: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsUrl({
        protocols: ['http', 'https'],
        require_protocol: true,
    })
    previewImageUrl?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    branch?: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsString()
    betaBranch?: string | null;
}

export class ArchiveCustomTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';
}

export class ForkTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';

    @ApiProperty()
    @IsString()
    templateId: string;

    @ApiProperty()
    @IsString()
    targetOwner: string;
}

export class RefreshTemplatesDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: 'website' | 'work';
}

export class CustomizeTemplateFromBaseDto {
    @ApiProperty({ description: 'Built-in base template id (e.g. "minimal").' })
    @IsString()
    baseTemplateId: string;

    @ApiProperty({ description: 'Display name for the new custom template.' })
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name: string;

    @ApiProperty({ description: 'UI customization prompt for the agent.' })
    @IsString()
    @MinLength(3)
    @MaxLength(4000)
    prompt: string;

    @ApiProperty({ description: 'Code-edit plugin id (claude-code, codex, gemini, opencode).' })
    @IsString()
    @MinLength(1)
    providerId: string;

    @ApiProperty({
        required: false,
        description: 'GitHub login (personal or org). Defaults to user.',
    })
    @IsOptional()
    @IsString()
    targetOwner?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;
}
