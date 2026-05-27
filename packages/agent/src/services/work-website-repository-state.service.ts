import { Injectable, Logger } from '@nestjs/common';
import { Work } from '@src/entities/work.entity';
import { User } from '@src/entities/user.entity';
import { GitFacadeService } from '@src/facades/git.facade';

@Injectable()
export class WorkWebsiteRepositoryStateService {
    private readonly logger = new Logger(WorkWebsiteRepositoryStateService.name);

    constructor(private readonly gitFacade: GitFacadeService) {}

    /**
     * Has this work's website repository been initialised?
     *
     * Two-stage check:
     *  1. **Fast DB-only path.** If any of five denormalised work columns
     *     is non-empty (`website`, `deployProjectId`,
     *     `websiteTemplateLastCommit`, `websiteTemplateLastUpdatedAt`,
     *     `websiteTemplateLastCheckedAt`), return `true` immediately. We
     *     only ever set these after a successful repo bootstrap, so a
     *     truthy value is a reliable positive signal.
     *  2. **Live repo probe.** If the DB says "not initialised", fall
     *     back to a `gitFacade.repositoryExists` call. Tries the caller's
     *     `user.id` AND the original `work.userId` (deduped) because the
     *     repo might have been created by either party — the current
     *     viewer may not have valid credentials but the work owner
     *     usually does, and vice versa. First credential set that
     *     reports the repo exists wins.
     *
     * Failure modes are all fail-safe: missing credentials → skip that
     * user, provider errors → log + continue, no successful check →
     * return `false`. The cost of a false negative is one redundant
     * bootstrap attempt; a false positive would skip a needed bootstrap
     * — much worse — so we err toward "not initialised" on uncertainty.
     */
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
