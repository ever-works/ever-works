import { IsIn, IsOptional, IsString } from 'class-validator';

export class GitHubAppSetupQueryDto {
    @IsString()
    installation_id: string;

    @IsOptional()
    @IsString()
    @IsIn(['install', 'request'])
    setup_action?: string;

    @IsOptional()
    @IsString()
    redirectTo?: string;
}

export class GitHubAppCallbackQueryDto {
    @IsString()
    code: string;

    @IsString()
    state: string;
}
