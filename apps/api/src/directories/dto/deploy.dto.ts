import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ValidateTokenDto {
    @ApiProperty({ description: 'Deployment provider API token to validate' })
    @IsString()
    token: string;
}
