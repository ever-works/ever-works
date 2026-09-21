import { Injectable, Logger } from '@nestjs/common';

import { GitFacadeService } from '../facades/git.facade';
import type { BuildTokenSource } from './build-facade.service';

/**
 * APW-05 T16 — the credential half of `BuildFacadeService`.
 *
 * `BuildFacadeService` needs one string: a provider token that can dispatch a
 * workflow in the App Work's repository. It gets it through a one-method port
 * so the facade itself has no opinion about where credentials live; this is the
 * binding that has one.
 *
 * ## Why `GitFacadeService.getAccessToken` and not a new credential path
 *
 * That method IS the platform's answer to "what token acts on this Work's
 * repository for this member", and it already resolves the whole ladder in the
 * right order: the Ever Works Git platform token for a Work whose repository
 * lives in the platform organisation, then a GitHub App installation token for
 * the Work, then the member's connected OAuth account, then a PAT from plugin
 * settings. Re-deriving any of that here would be a second ladder that drifts
 * from the first, and the first is the one every other git operation on the Work
 * already uses.
 *
 * It is also why the token is fetched per call rather than held: the ladder's
 * answer changes when an installation is added or a member reconnects, and a
 * cached build token would keep dispatching with a credential the member has
 * revoked.
 *
 * ## A missing credential is `null`, never a throw
 *
 * `getAccessToken` answers `null` for "no usable credential" but THROWS for some
 * shapes of missing configuration (`NoGitCredentialsError`, and the "no userId"
 * guard). Both mean the same thing to a Build: it cannot start, and it should
 * say so as a refusal rather than as a crashed request. So every throw is caught
 * and turned into `null` — with the reason logged, because "the member has not
 * connected GitHub" and "the credential store is down" look identical from the
 * outside and are very different to whoever has to fix one.
 *
 * **The token is never logged.** Only whether one was obtained.
 */
@Injectable()
export class GitBuildTokenSource implements BuildTokenSource {
    private readonly logger = new Logger(GitBuildTokenSource.name);

    constructor(private readonly gitFacade: GitFacadeService) {}

    async getBuildToken(input: {
        readonly workId: string;
        readonly userId: string;
        readonly providerId: string;
    }): Promise<string | null> {
        try {
            const token = await this.gitFacade.getAccessToken({
                workId: input.workId,
                userId: input.userId,
                providerId: input.providerId,
            });
            if (!token || token.trim().length === 0) {
                this.logger.warn(
                    `Build credential for work ${input.workId}: the git facade has no usable ${input.providerId} credential for member ${input.userId}.`,
                );
                return null;
            }
            return token;
        } catch (error) {
            this.logger.warn(
                `Build credential for work ${input.workId}: the ${input.providerId} credential lookup failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }
}
