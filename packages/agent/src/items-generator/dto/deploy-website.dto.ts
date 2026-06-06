import { IsOptional, IsString, MaxLength } from 'class-validator';

// Security (resource exhaustion / secret-bloat): these optional fields carry
// deployment secrets supplied by the caller and flow into provider secret
// stores / subprocess env. Bound their length so an abusive caller cannot
// submit a multi-megabyte "token" to bloat logs, secret storage, or env.
// 512 is far above any real GitHub PAT (~40-255) or Vercel token (~24), so
// no legitimate token is rejected.
const MAX_TOKEN_LENGTH = 512;

export class DeployWebsiteDto {
    @IsOptional()
    @IsString()
    @MaxLength(MAX_TOKEN_LENGTH)
    DEPLOY_TOKEN?: string;

    @IsOptional()
    @IsString()
    @MaxLength(MAX_TOKEN_LENGTH)
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
