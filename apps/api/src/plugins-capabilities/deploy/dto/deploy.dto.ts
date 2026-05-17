import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DeployWorkDto {
    @ApiPropertyOptional({ description: 'Team scope for deployment' })
    @IsString()
    @IsOptional()
    teamScope?: string;
}

export class RollbackDto {
    @ApiProperty({ description: 'Deployment id to roll back to' })
    @IsString()
    deploymentId: string;
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
