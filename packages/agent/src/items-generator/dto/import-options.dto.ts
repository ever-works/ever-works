import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ImportDuplicateStrategy } from '../item-import-export.types';

export const IMPORT_DUPLICATE_STRATEGIES: readonly ImportDuplicateStrategy[] = [
    'skip',
    'update',
] as const;

export class ImportOptionsDto {
    @ApiProperty({
        description:
            'How to handle rows whose `slug` or `source_url` matches an existing item: ' +
            '`skip` leaves the existing item untouched; `update` overwrites it.',
        enum: IMPORT_DUPLICATE_STRATEGIES,
        default: 'skip',
    })
    @IsEnum(IMPORT_DUPLICATE_STRATEGIES as readonly string[])
    duplicate_strategy: ImportDuplicateStrategy;

    @ApiPropertyOptional({
        description:
            'Status to apply to created items when the row does not specify one. ' +
            'Defaults are decided by the import service per directory.',
    })
    @IsOptional()
    @IsString()
    default_status?: string;
}
