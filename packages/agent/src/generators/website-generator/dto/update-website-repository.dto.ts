export interface UpdateWebsiteRepositoryResponseDto {
    status: 'success' | 'error';
    slug: string;
    owner: string;
    repository: string;
    message: string;
    method_used?: string;
}
