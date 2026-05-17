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
    @ApiProperty({
        description:
            'Built-in template id to fork+customize. Must have customizable: true and a registered prompt.',
    })
    @IsString()
    baseTemplateId: string;

    @ApiProperty({
        description: 'Free-text description of the UI changes the agent should apply.',
    })
    @IsString()
    @MinLength(3)
    @MaxLength(4000)
    prompt: string;

    @ApiProperty({
        required: false,
        description:
            'GitHub login (personal or org) to fork into. Defaults to the user’s personal GitHub login.',
    })
    @IsOptional()
    @IsString()
    targetOwner?: string;

    @ApiProperty({
        required: false,
        description:
            'Explicit code-edit provider id (claude-code | codex | gemini | opencode). Defaults to the first loaded provider.',
    })
    @IsOptional()
    @IsString()
    providerId?: string;
}
