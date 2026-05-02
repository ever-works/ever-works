export interface SwitchWebsiteTemplateResponseDto {
    status: 'success' | 'error';
    slug: string;
    owner: string;
    repository: string;
    websiteTemplateId: string;
    repositoryRecreated: boolean;
    message: string;
}
