import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import { Work, RepoVisibility } from '../entities/work.entity';
import { User } from '../entities/user.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import {
    assertNotRepositoryWork,
    assertRepositoryRole,
    hasRepositoryRole,
} from '../works/repository-work-guard';

export type RepositoryType = 'data' | 'work' | 'website';

export interface RepositoryStatus {
    type: RepositoryType;
    name: string;
    url: string;
    isPrivate: boolean;
    exists: boolean;
}

/**
 * Read/update visibility status for the three repos a Work owns on its
 * git provider — the data repo (`.content` source), the main work repo
 * (`.works` config), and the website repo (deployed site).
 *
 * Two contracts worth knowing:
 *
 * - **Status is best-effort with default-safe fallback.**
 *   `getRepositoriesStatus` fans out across the three repos in parallel
 *   and on *any* error from the provider (404, 500, network, auth)
 *   treats the repo as `{ exists: false, isPrivate: true }`. The
 *   `isPrivate: true` default is deliberate — `false` would leak a
 *   "looks public" status if the provider call merely failed, which
 *   could mislead operators into not noticing a real visibility
 *   misconfiguration. The inline `// Ignore 404, treat as not exists`
 *   comment understates the catch's actual scope: anything that throws
 *   is silently swallowed.
 *
 * - **Visibility cache is opportunistically refreshed.** The result is
 *   compared against the work's stored `repoVisibility` and the DB row
 *   is only written when one of the three flags changed. This is a
 *   read path that occasionally writes; callers in tight loops should
 *   prefer `Work.repoVisibility` directly rather than re-issuing
 *   `getRepositoriesStatus()` per render.
 */
@Injectable()
export class RepositoryManagementService {
    private readonly logger = new Logger(RepositoryManagementService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly workRepository: WorkRepository,
    ) {}

    async getRepositoriesStatus(work: Work, user: User): Promise<RepositoryStatus[]> {
        // Only the roles this kind provisions are listed. The entity's
        // fallbacks (`<slug>`, `<slug>-website`) name repositories a
        // Repository / Company / Campaign Work never created — and for a
        // Repository Work whose slug came from the wrapped repo, `<slug>` IS
        // the wrapped repo, which would then show up twice under two roles.
        const allRoles: { type: RepositoryType; name: string }[] = [
            { type: 'data', name: work.getDataRepo() },
            { type: 'work', name: work.getMainRepo() },
            { type: 'website', name: work.getWebsiteRepo() },
        ];
        const repos = allRoles.filter((repo) => hasRepositoryRole(work, repo.type));

        const results = await Promise.all(
            repos.map(async (repo) => {
                const owner = work.getRepoOwner(repo.type);
                try {
                    const data = await this.gitFacade.getRepository(owner, repo.name, {
                        userId: user.id,
                        providerId: work.gitProvider,
                        workId: work.id,
                    });
                    if (data) {
                        return {
                            type: repo.type,
                            name: repo.name,
                            url: data.url,
                            isPrivate: data.isPrivate,
                            exists: true,
                        };
                    }
                } catch (error) {
                    // Swallows ANY error (not just 404) — see class JSDoc.
                    // Default-safe fallback (isPrivate: true) below ensures
                    // we never report a transient failure as "public".
                }
                return {
                    type: repo.type,
                    name: repo.name,
                    url: '',
                    isPrivate: true, // Default safe assumption
                    exists: false,
                };
            }),
        );

        // Update DB cache
        const newVisibility: RepoVisibility = {
            data: results.find((r) => r.type === 'data')?.isPrivate ?? true,
            work: results.find((r) => r.type === 'work')?.isPrivate ?? true,
            website: results.find((r) => r.type === 'website')?.isPrivate ?? true,
        };

        // Only update if changed
        const currentVisibility = work.repoVisibility;
        if (
            !currentVisibility ||
            currentVisibility.data !== newVisibility.data ||
            currentVisibility.work !== newVisibility.work ||
            currentVisibility.website !== newVisibility.website
        ) {
            await this.workRepository.update(work.id, {
                repoVisibility: newVisibility,
            });
        }

        return results;
    }

    async updateRepositoryVisibility(
        work: Work,
        user: User,
        repoType: RepositoryType,
        isPrivate: boolean,
    ): Promise<RepositoryStatus> {
        const owner = work.getRepoOwner(repoType);
        let repoName: string;

        switch (repoType) {
            case 'data':
                repoName = work.getDataRepo();
                break;
            case 'work':
                repoName = work.getMainRepo();
                break;
            case 'website':
                repoName = work.getWebsiteRepo();
                break;
            default:
                throw new Error('Invalid repository type');
        }

        // Flipping visibility rewrites repository settings on the provider.
        // For a Repository Work every role resolves to a repository the
        // platform did not create — the wrapped repo itself under `data`,
        // and a derived name under the others — so none of them is ours to
        // change. Other kinds are refused only for roles they never
        // provision (a Company Work has no website repo to flip). Checked
        // after the switch so an unknown role keeps its own error.
        assertNotRepositoryWork(work, 'changing repository visibility');
        assertRepositoryRole(work, repoType);

        const updated = await this.gitFacade.updateRepository(
            owner,
            repoName,
            { isPrivate },
            { userId: user.id, providerId: work.gitProvider, workId: work.id },
        );

        // Update DB cache
        const currentVisibility = work.repoVisibility || {
            data: true,
            work: true,
            website: true,
        };
        const newVisibility = { ...currentVisibility };
        newVisibility[repoType] = updated.isPrivate;

        await this.workRepository.update(work.id, {
            repoVisibility: newVisibility,
        });

        return {
            type: repoType,
            name: repoName,
            url: updated.url,
            isPrivate: updated.isPrivate,
            exists: true,
        };
    }
}
