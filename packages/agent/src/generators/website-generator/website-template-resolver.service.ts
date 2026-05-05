import { Injectable } from '@nestjs/common';
import { TemplateRepository } from '@src/database/repositories/template.repository';
import {
    getWebsiteTemplateConfig as getStaticWebsiteTemplateConfig,
    type WebsiteTemplateConfig,
} from './config/website-template.config';

@Injectable()
export class WebsiteTemplateResolverService {
    constructor(private readonly templateRepository: TemplateRepository) {}

    async resolve(templateId?: string | null): Promise<WebsiteTemplateConfig> {
        if (templateId) {
            const template = await this.templateRepository.findById(templateId);
            if (template && template.kind === 'website' && template.isActive) {
                return {
                    id: template.id,
                    name: template.name,
                    description: template.description || '',
                    owner: template.repositoryOwner,
                    repo: template.repositoryName,
                    branch: template.branch,
                    syncBranches: template.syncBranches,
                    betaBranch: template.betaBranch,
                };
            }
        }

        return getStaticWebsiteTemplateConfig(templateId);
    }
}
