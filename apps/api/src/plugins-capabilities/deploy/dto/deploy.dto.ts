import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DeployDirectoryDto {
    @ApiPropertyOptional({ description: 'Team scope for deployment' })
    @IsString()
    @IsOptional()
    teamScope?: string;
}

export class ValidateTokenDto {
    @ApiProperty({ description: 'Deployment provider ID' })
    @IsString()
    providerId: string;
}

export class GetTeamsDto {
    @ApiProperty({ description: 'Deployment provider ID' })
    @IsString()
    providerId: string;
}
