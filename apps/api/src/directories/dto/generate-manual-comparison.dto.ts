import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GenerateManualComparisonDto {
    @ApiProperty({ description: 'Slug of the first item to compare' })
    @IsString()
    @IsNotEmpty()
    itemASlug: string;

    @ApiProperty({ description: 'Slug of the second item to compare' })
    @IsString()
    @IsNotEmpty()
    itemBSlug: string;
}
