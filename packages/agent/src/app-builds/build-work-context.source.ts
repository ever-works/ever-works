import type { WorkRepository } from '../database/repositories/work.repository';
import type { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import type {
    AppBuildPluginResolver,
    AppBuildWorkContext,
    AppBuildWorkSource,
} from './app-builds.service';

/**
 * APW-05 — `APP_BUILD_WORK_SOURCE`: the six facts a Build row cannot be written
 * without.
 *
 * Unbound, `AppBuildsService.requestPrepare` answers `workUnavailable` for every
 * App Work, so **no Build could be requested at all** — which is the same shape
 * of dormancy `APP_BUILD_PLUGIN_RESOLVER` was in until 2026-09-21: real code,
 * reachable by nothing.
 *
 * There is no single row holding all six, which is why this is an adapter and
 * not an alias. Each one comes from the owner of that fact:
 *
 * | Fact                    | Read from                                      |
 * | ----------------------- | ---------------------------------------------- |
 * | `userId`                | `Work.userId` — the App Work's owner            |
 * | `trackedBranch`         | APW-03's `WorkAppSpecState.trackedBranch`      |
 * | `buildPluginId`         | T16's `AppBuildPluginResolver.resolve`         |
 * | `repositoryFullName`    | `Work.sourceRepository.owner/repo`             |
 * | `repositoryVisibility`  | fails safe to `private` — see below             |
 *
 * ## `null` means "cannot answer", and every caller treats it that way
 *
 * A Work that does not exist, one with no App source repository, or one whose
 * tracked branch cannot be read all answer `null` rather than a context with a
 * guessed field in it. A Build is a push to a member's repository; a fabricated
 * branch or owner would push the wrong thing to the wrong place.
 *
 * ## Visibility is `private`, always, and that is not a placeholder
 *
 * Nothing in this tree records a repository's visibility: not `Work`, not
 * `SourceRepository`, not `WorkUpstreamState`. `upstream-build-facts.source.ts`
 * reached the same wall and made the same choice, so the two agree rather than
 * disagreeing in a way nobody would notice.
 *
 * `private` is the safe direction in both places it is read: it selects the
 * larger runner class and it makes the Build acquire a pull token. A public
 * repository treated as private builds correctly and costs more; a private one
 * treated as public fails at the pull with a message about the registry. When
 * APW-02 records the provider's answer, both files read it instead — the
 * fallback is written down in both so the next reader finds one story.
 */
export class AppBuildWorkContextSource implements AppBuildWorkSource {
    constructor(
        private readonly works: WorkRepository,
        private readonly specStates: WorkAppSpecStateRepository | null,
        private readonly plugins: AppBuildPluginResolver | null,
    ) {}

    async read(workId: string): Promise<AppBuildWorkContext | null> {
        const work = await this.works.findById(workId);
        if (!work) return null;

        const userId = typeof work.userId === 'string' ? work.userId : '';
        if (!userId) return null;

        const source = work.sourceRepository;
        const owner = typeof source?.owner === 'string' ? source.owner.trim() : '';
        const repo = typeof source?.repo === 'string' ? source.repo.trim() : '';
        if (!owner || !repo) {
            // An App Work always has one (APW-01 records it at create). Without
            // it there is no repository to build, and inventing `owner/repo`
            // from the slug would dispatch a workflow at a repository nobody
            // asked about.
            return null;
        }

        const trackedBranch = await this.trackedBranch(workId);
        if (!trackedBranch) return null;

        const binding = this.plugins ? await this.plugins.resolve(workId, userId) : null;
        if (!binding?.pluginId) {
            // `AppBuildsService` cannot write a Build row without knowing which
            // plugin will run it, and the resolver has already logged WHY it
            // could not answer (no registry, no plugin, no credential).
            return null;
        }

        return {
            workId,
            userId,
            trackedBranch,
            buildPluginId: binding.pluginId,
            repositoryFullName: `${owner}/${repo}`,
            // See the class docstring. Not a guess, a documented fail-safe.
            repositoryVisibility: 'private',
        };
    }

    /**
     * The only branch a Build may run for (FR-14).
     *
     * APW-03's state row is the one place it is recorded. An installation
     * without the repository bound, or a Work with no state row yet, answers
     * `null` rather than defaulting to `main`: a Build dispatched on the wrong
     * branch builds the wrong commit, and "we assumed main" is not something a
     * member can see or correct.
     */
    private async trackedBranch(workId: string): Promise<string | null> {
        if (!this.specStates) return null;

        try {
            const state = await this.specStates.findByWorkId(workId);
            const branch =
                typeof state?.trackedBranch === 'string' ? state.trackedBranch.trim() : '';
            return branch.length > 0 ? branch : null;
        } catch {
            return null;
        }
    }
}
