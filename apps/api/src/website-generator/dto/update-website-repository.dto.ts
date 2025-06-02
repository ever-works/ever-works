import { IsString, IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateWebsiteRepositoryDto {
    @IsString()
    @IsNotEmpty()
    slug: string;

    @IsString()
    @IsNotEmpty()
    owner: string;

    @IsBoolean()
    isOrganization: boolean;
}

export interface UpdateWebsiteRepositoryResponseDto {
    status: 'success' | 'error';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    method_used?: string;
    error_details?: string;
}
