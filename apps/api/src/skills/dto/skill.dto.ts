import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
} from 'class-validator';
import type { SkillBindingTargetType, SkillOwnerType } from '@ever-works/agent/skills';

export const SKILL_OWNER_TYPES = ['tenant', 'mission', 'idea', 'work', 'agent'] as const;
export const SKILL_BINDING_TARGET_TYPES = ['tenant', 'mission', 'idea', 'work', 'agent'] as const;

export class ListSkillsQueryDto {
    @ApiPropertyOptional({ enum: SKILL_OWNER_TYPES })
    @IsOptional()
    @IsEnum(SKILL_OWNER_TYPES)
    ownerType?: SkillOwnerType;

    @ApiPropertyOptional()
    @IsOptional()
    @IsUUID()
    ownerId?: string;

    @ApiPropertyOptional({ maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    search?: string;

    @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
    @IsOptional()
    @Transform(({ value }) => (value === undefined || value === null ? value : Number(value)))
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiPropertyOptional({ minimum: 0, default: 0 })
    @IsOptional()
    @Transform(({ value }) => (value === undefined || value === null ? value : Number(value)))
    @IsInt()
    @Min(0)
    offset?: number;
}

export class ListSkillCatalogQueryDto {
    @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
    @IsOptional()
    @Transform(({ value }) => (value === undefined || value === null ? value : Number(value)))
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiPropertyOptional({ minimum: 0, default: 0 })
    @IsOptional()
    @Transform(({ value }) => (value === undefined || value === null ? value : Number(value)))
    @IsInt()
    @Min(0)
    offset?: number;

    @ApiPropertyOptional({ maxLength: 500 })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    search?: string;

    @ApiPropertyOptional({ isArray: true, type: String })
    @IsOptional()
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') return undefined;
        const values = Array.isArray(value) ? value : String(value).split(',');
        return values.map((tag) => String(tag).trim()).filter(Boolean);
    })
    @IsString({ each: true })
    @MaxLength(80, { each: true })
    tags?: string[];
}

export class CreateSkillDto {
    @ApiProperty({ enum: SKILL_OWNER_TYPES })
    @IsEnum(SKILL_OWNER_TYPES)
    ownerType: SkillOwnerType;

    @ApiProperty()
    @IsUUID()
    ownerId: string;

    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title: string;

    @ApiProperty({ minLength: 1, maxLength: 1000 })
    @IsString()
    @MinLength(1)
    @MaxLength(1000)
    description: string;

    @ApiProperty({ type: String, maxLength: 65536 })
    @IsString()
    @MaxLength(65536)
    instructionsMd: string;

    @ApiPropertyOptional({
        type: 'object',
        additionalProperties: true,
    })
    @IsOptional()
    @IsObject()
    frontmatter?: Record<string, unknown>;

    @ApiPropertyOptional({ pattern: '^[a-z0-9-]{1,80}$' })
    @IsOptional()
    @IsString()
    @Matches(/^[a-z0-9-]{1,80}$/)
    slug?: string;

    @ApiPropertyOptional({ maxLength: 40 })
    @IsOptional()
    @IsString()
    @MaxLength(40)
    version?: string;
}

export class UpdateSkillDto {
    @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title?: string;

    @ApiPropertyOptional({ minLength: 1, maxLength: 1000 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(1000)
    description?: string;

    @ApiPropertyOptional({ type: String, maxLength: 65536 })
    @IsOptional()
    @IsString()
    @MaxLength(65536)
    instructionsMd?: string;

    @ApiPropertyOptional({
        type: 'object',
        additionalProperties: true,
    })
    @IsOptional()
    @IsObject()
    frontmatter?: Record<string, unknown>;

    @ApiPropertyOptional({ maxLength: 40 })
    @IsOptional()
    @IsString()
    @MaxLength(40)
    version?: string;
}

export class InstallCatalogSkillDto {
    @ApiProperty({ pattern: '^[a-z0-9-]{1,80}$' })
    @IsString()
    @Matches(/^[a-z0-9-]{1,80}$/)
    slug: string;

    @ApiProperty({ enum: SKILL_OWNER_TYPES })
    @IsEnum(SKILL_OWNER_TYPES)
    ownerType: SkillOwnerType;

    @ApiProperty()
    @IsUUID()
    ownerId: string;
}

export class CreateSkillBindingDto {
    @ApiProperty({ enum: SKILL_BINDING_TARGET_TYPES })
    @IsEnum(SKILL_BINDING_TARGET_TYPES)
    targetType: SkillBindingTargetType;

    @ApiPropertyOptional({ nullable: true })
    @IsOptional()
    @ValidateIf((o) => o.targetId !== null)
    @IsUUID()
    targetId?: string | null;

    @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 100 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(1000)
    priority?: number;

    @ApiPropertyOptional({ default: true })
    @IsOptional()
    @IsBoolean()
    injectIntoAgent?: boolean;

    @ApiPropertyOptional({ default: false })
    @IsOptional()
    @IsBoolean()
    injectIntoGenerator?: boolean;
}
