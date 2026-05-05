import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

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
