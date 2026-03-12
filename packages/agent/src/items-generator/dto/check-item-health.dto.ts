import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { CheckItemHealthDto as ICheckItemHealthDto } from '@ever-works/contracts/api';

export class CheckItemHealthDto implements ICheckItemHealthDto {
    @ApiProperty({ description: 'Slug of the item to check' })
    @IsString()
    item_slug: string;
}
