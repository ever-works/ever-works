import { IsOptional, IsString } from 'class-validator';

export class DeployVercelDto {
    @IsOptional()
    @IsString()
    VERCEL_TOKEN?: string;

    @IsOptional()
    @IsString()
    GITHUB_TOKEN?: string;

    @IsOptional()
    @IsString()
    vercelTeamId?: string;
}
