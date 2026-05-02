export type WebsiteTemplateSwitchMode =
    | 'saved_for_initialization'
    | 'repository_reset'
    | 'repository_recreated';

export interface SwitchWebsiteTemplateResponseDto {
    status: 'success' | 'error';
    slug: string;
    owner: string;
    repository: string;
    previousWebsiteTemplateId: string;
    websiteTemplateId: string;
    repositoryRecreated: boolean;
    switchMode: WebsiteTemplateSwitchMode;
    message: string;
}
