import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

// Must mirror `TemplateKind` in packages/agent/src/entities/template.entity.ts.
// Phase 8 PR W/X added 'mission' (Mission Templates catalog filter); Phase 11
// added 'company'. Keeping both kinds here lets the catalog/fork endpoints
// accept them; the repository's findVisibleByKind() does the actual lookup.
const TEMPLATE_KINDS = ['website', 'work', 'mission', 'company'] as const;
type TemplateKindLiteral = (typeof TEMPLATE_KINDS)[number];

export class ListTemplatesQueryDto {
    // Back-compat: pre-PR-W callers hit `/api/templates` with no kind and
    // got Work templates. PR-W added the `kind=mission` filter as an
    // extension — `kind` is optional, defaulting to 'work'.
    @ApiPropertyOptional({ enum: TEMPLATE_KINDS, default: 'work' })
    @IsOptional()
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: TemplateKindLiteral = 'work';
}

export class AddCustomTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: TemplateKindLiteral;

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
    kind: TemplateKindLiteral;

    @ApiProperty()
    @IsString()
    templateId: string;
}

export class UpdateCustomTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: TemplateKindLiteral;

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
    kind: TemplateKindLiteral;
}

export class ForkTemplateDto {
    @ApiProperty({ enum: TEMPLATE_KINDS })
    @IsString()
    @IsIn(TEMPLATE_KINDS)
    kind: TemplateKindLiteral;

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
    kind: TemplateKindLiteral;
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

    @ApiPropertyOptional({
        description:
            'AI provider plugin id, required when the chosen code-edit plugin declares "ai-provider" in selectableProviderCategories (e.g. opencode).',
    })
    @IsOptional()
    @IsString()
    aiProviderId?: string;

    @ApiPropertyOptional({ description: 'GitHub login (personal or org). Defaults to user.' })
    @IsOptional()
    @IsString()
    targetOwner?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;
}

export class IterateCustomTemplateDto {
    @ApiProperty({ description: 'New customization prompt for the agent.' })
    @IsString()
    @MinLength(3)
    @MaxLength(4000)
    prompt: string;

    @ApiProperty({ description: 'Code-edit plugin id (claude-code, codex, gemini, opencode).' })
    @IsString()
    @MinLength(1)
    providerId: string;

    @ApiPropertyOptional({
        description:
            'AI provider plugin id, required when the chosen code-edit plugin declares "ai-provider" in selectableProviderCategories.',
    })
    @IsOptional()
    @IsString()
    aiProviderId?: string;
}
