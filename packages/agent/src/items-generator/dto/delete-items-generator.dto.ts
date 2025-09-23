import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class DeleteDirectoryDto {
    @IsOptional()
    @IsString()
    reason?: string;

    @IsOptional()
    @IsBoolean()
    force_delete?: boolean = false;

    @IsOptional()
    @IsBoolean()
    delete_data_repository?: boolean = false;

    @IsOptional()
    @IsBoolean()
    delete_markdown_repository?: boolean = false;

    @IsOptional()
    @IsBoolean()
    delete_website_repository?: boolean = false;
}

export interface DeleteDirectoryResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    deleted_repositories?: string[];
}
