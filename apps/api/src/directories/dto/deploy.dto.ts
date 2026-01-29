import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VercelTokenDto {
    @ApiProperty({ description: 'Vercel API token to validate' })
    @IsString()
    token: string;
}
