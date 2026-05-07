import { Injectable, Logger } from '@nestjs/common';
import { Work } from '@src/entities/work.entity';
import { User } from '@src/entities/user.entity';
import { GitFacadeService } from '@src/facades/git.facade';

@Injectable()
export class WorkWebsiteRepositoryStateService {
    private readonly logger = new Logger(WorkWebsiteRepositoryStateService.name);

    constructor(private readonly gitFacade: GitFacadeService) {}

    async isInitialized(work: Work, user: User): Promise<boolean> {
        if (
            work.website ||
            work.deployProjectId ||
            work.websiteTemplateLastCommit ||
            work.websiteTemplateLastUpdatedAt ||
            work.websiteTemplateLastCheckedAt
        ) {
            return true;
        }

        const userIds = [...new Set([user.id, work.userId].filter(Boolean))];

        for (const userId of userIds) {
            const authOptions = {
                userId,
                providerId: work.gitProvider,
                workId: work.id,
            };

            const hasCredentials = await this.gitFacade.hasValidCredentials(authOptions);
            if (!hasCredentials) {
                continue;
            }

            try {
                const exists = await this.gitFacade.repositoryExists(
                    work.getRepoOwner('website'),
                    work.getWebsiteRepo(),
                    authOptions,
                );

                if (exists) {
                    return true;
                }
            } catch (error) {
                this.logger.warn(
                    `Failed to verify website repository initialization for work ${work.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return false;
    }
}
