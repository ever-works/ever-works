import { Injectable, Logger } from '@nestjs/common';
import { TemplateRepository } from '@src/database/repositories/template.repository';
import { UserTemplatePreferenceRepository } from '@src/database/repositories/user-template-preference.repository';
import {
    findWebsiteTemplateConfig,
    getDefaultWebsiteTemplateId,
    getWebsiteTemplateConfig as getStaticWebsiteTemplateConfig,
    type WebsiteTemplateConfig,
} from './config/website-template.config';
import type { Work } from '@src/entities/work.entity';

/**
 * Resolves the {@link WebsiteTemplateConfig} a Work should use for
 * generation/update.
 *
 * Two layered lookup sources:
 * - **Catalog** (`templates` table) — operator-managed; live data,
 *   supports `isActive` soft-disable and `kind === 'website'` scoping.
 * - **Static config** (`./config/website-template.config`) — code-
 *   shipped fallback list. The seed/default of the system.
 *
 * Lookup behaviours, asymmetric on purpose:
 * - `resolve(templateId)`:
 *   - `templateId` is null/empty → default static config.
 *   - `templateId` set → catalog hit (must be active + `kind: website`)
 *     wins; else static-by-id; else **throw** (caller hit an explicit
 *     unknown id, surfaces as an error).
 * - `resolveForWork(work)`:
 *   - `work.websiteTemplateId` set → delegates to `resolve()` (throws
 *     on unknown).
 *   - Else if the user has a saved `userTemplatePreference` for kind
 *     `website` → try **catalog only** (no static fallback for user
 *     prefs), then on miss continue to default.
 *   - Else → default static config.
 *
 * Soft-disable trap: an `isActive: false` catalog entry whose id also
 * exists in static config silently uses the static one rather than
 * erroring. That's the intended "shadow with static" behaviour but
 * means operators flipping `isActive` off don't necessarily take the
 * template offline. Use the static-config purge if you need a hard
 * disable.
 */
@Injectable()
export class WebsiteTemplateResolverService {
    private readonly logger = new Logger(WebsiteTemplateResolverService.name);

    constructor(
        private readonly templateRepository: TemplateRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
    ) {}

    private async findCatalogTemplateConfig(
        templateId?: string | null,
    ): Promise<WebsiteTemplateConfig | null> {
        if (!templateId) {
            return null;
        }

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

        return null;
    }

    async resolve(templateId?: string | null): Promise<WebsiteTemplateConfig> {
        if (!templateId) {
            return getStaticWebsiteTemplateConfig(templateId);
        }

        const catalogTemplate = await this.findCatalogTemplateConfig(templateId);
        if (catalogTemplate) {
            return catalogTemplate;
        }

        const staticTemplate = findWebsiteTemplateConfig(templateId);
        if (staticTemplate) {
            return staticTemplate;
        }

        this.logger.error(
            `Website template "${templateId}" is unavailable or inactive and cannot be resolved`,
        );
        throw new Error(`Website template "${templateId}" is unavailable or inactive.`);
    }

    async resolveForWork(
        work: Pick<Work, 'userId'> & { websiteTemplateId?: string | null },
    ): Promise<WebsiteTemplateConfig> {
        if (work.websiteTemplateId) {
            return this.resolve(work.websiteTemplateId);
        }

        const preference = await this.userTemplatePreferenceRepository.findByUserAndKind(
            work.userId,
            'website',
        );

        if (preference?.templateId) {
            const preferredTemplate = await this.findCatalogTemplateConfig(preference.templateId);
            if (preferredTemplate) {
                return preferredTemplate;
            }
        }

        return getStaticWebsiteTemplateConfig(getDefaultWebsiteTemplateId());
    }
}
