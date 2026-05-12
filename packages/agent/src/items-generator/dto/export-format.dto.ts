import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { ExportFormat } from '../item-import-export.types';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'xlsx'] as const;

export class ExportFormatDto {
    @ApiProperty({
        description: 'Output format for an item export download.',
        enum: EXPORT_FORMATS,
        example: 'xlsx',
    })
    @IsEnum(EXPORT_FORMATS as readonly string[])
    format: ExportFormat;
}
