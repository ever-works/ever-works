import { IsOptional, IsString } from 'class-validator';

export class DeployWebsiteDto {
    @IsOptional()
    @IsString()
    VERCEL_TOKEN?: string;

    @IsOptional()
    @IsString()
    GITHUB_TOKEN?: string;
}

export interface DeployWebsiteResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    deployment_url?: string;
}
