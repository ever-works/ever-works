import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_BUILD_IMAGE_NAME, type AppBuildKind } from '@ever-works/contracts';
import type { BuildAuth, BuildRef, IBuildPlugin, StartBuildInput } from '@ever-works/plugin';

import { WorkRepository } from '../database/repositories/work.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import type { AppBuildPluginBinding, AppBuildPluginResolver } from './app-builds.service';

/**
 * DI token for {@link BuildTokenSource}.
 *
 * Declared ABOVE the class that injects it: `@Inject()` evaluates its argument
 * at decorator time, and a `const` declared further down the file is in its
 * temporal dead zone at that moment (TS2448).
 */
export const BUILD_TOKEN_SOURCE = Symbol('BUILD_TOKEN_SOURCE');

/** DI token for {@link BuildRepositoryFactsSource}. Declared here for the same reason. */
export const BUILD_REPOSITORY_FACTS_SOURCE = Symbol('BUILD_REPOSITORY_FACTS_SOURCE');

/**
 * APW-05 T16 — `BuildFacadeService.resolve(workId, userId)`, the binding behind
 * `APP_BUILD_PLUGIN_RESOLVER`.
 *
 * ## Why this is the piece that was missing
 *
 * Four services inject `APP_BUILD_PLUGIN_RESOLVER` — `AppBuildsService`, the
 * prepare runner, the watch runner and the pull-token service — and until now
 * nothing provided it, so every one of them took its `pluginUnavailable` branch
 * and no Build could be requested at all.
 *
 * It was only half the gate, though, and the more interesting half was
 * underneath: until 2026-09-21 the one plugin that declares
 * `capabilities: ['build']` threw `notImplemented` from every build member, so a
 * bound resolver would have reached a plugin that refused on the first call.
 * APW-05 T12 implemented four of the five; this file is what lets anything reach
 * them.
 *
 * ## Resolution, and why it is by CAPABILITY and not by a Work setting
 *
 * `null` means "this App Work has no build plugin" — never a fallback plugin and
 * never a silent success (`AppBuildPluginResolver`'s own docstring). A Work
 * carries `deployProvider`, which is the DEPLOY plugin; there is no
 * `buildProvider` column, and inventing one here would be a schema decision made
 * in a facade. So the resolution is: the loaded plugins that declare the `build`
 * capability, of which there is exactly one today.
 *
 * When a second build plugin lands, this is the function that has to learn how a
 * Work chooses between them — and {@link BuildFacadeService.resolve} refuses
 * rather than picking, because picking one of two silently is how a Build ends
 * up running somewhere its owner did not choose.
 *
 * ## The image repository is derived, not configured
 *
 * `ghcr.io/<owner>/<repo>/ever-works-app` (`APP_BUILD_IMAGE_NAME`) in lower
 * case, from the Work's own repository coordinates — exactly the `EW_IMAGE` the
 * generated workflow pushes (`buildImageRepository` in the github-actions-build
 * plugin). GHCR requires lower case and rejects anything else, and deriving it
 * means an App Work has a working image repository without anybody configuring
 * one. It is also the ONLY repository {@link AppBuildPluginBinding.checkImageAccess}
 * will read: the binding is Work-bound, so a caller cannot point the registry
 * read (or a pull token) at somebody else's image.
 *
 * Until 2026-09-25 this was `ghcr.io/<owner>/<repo>`, one path segment short of
 * where the workflow pushes, so any registry check through the binding looked up
 * an image that never exists (APW-05 T14).
 */
@Injectable()
export class BuildFacadeService implements AppBuildPluginResolver {
    private readonly logger = new Logger(BuildFacadeService.name);

    constructor(
        /**
         * The plugin registry.
         *
         * `@Optional()` although this facade is useless without it, because
         * `PluginsModule` is `@Global()` and registered with `forRoot()` at the
         * API root: it IS present in every running process, and it is NOT present
         * when a module is compiled on its own, which is what
         * `app-builds.module.spec.ts` does to prove the module composes. A
         * required injection here makes that spec fail at
         * `Test.createTestingModule` with `Nest can't resolve dependencies of the
         * BuildFacadeService`, which is a true statement about the test harness
         * and a false one about production.
         *
         * Absent, {@link resolve} refuses and says WHICH half was missing, so an
         * operator never sees "no build plugin" when the real answer is "the
         * plugin system was not registered".
         */
        @Optional()
        private readonly registry: PluginRegistryService | undefined,
        private readonly workRepository: WorkRepository,
        /**
         * How a member's provider token is obtained.
         *
         * `@Optional()` and last: with nothing bound, {@link resolve} answers
         * `null` rather than a binding whose `startBuild` would fail on an empty
         * token. "No credential" and "no plugin" are different, and both are
         * refusals, so collapsing them here costs nothing a caller can use — the
         * log line below is what distinguishes them for an operator.
         */
        @Optional()
        @Inject(BUILD_TOKEN_SOURCE)
        private readonly tokens?: BuildTokenSource,
        /**
         * Where the repository's visibility and provenance come from.
         *
         * `@Optional()` and last for the same reason as the token source, and
         * with SAFE defaults rather than convenient ones when it is absent — see
         * {@link BuildFacadeService.factsFor}.
         */
        @Optional()
        @Inject(BUILD_REPOSITORY_FACTS_SOURCE)
        private readonly facts?: BuildRepositoryFactsSource,
    ) {}

    /**
     * The App Work's build plugin, or `null`.
     *
     * Every refusal is logged with its reason and answers `null`; none throws.
     * The callers treat a `null` as `pluginUnavailable`, which is a Build that
     * does not start rather than one that half-starts.
     */
    async resolve(workId: string, userId: string): Promise<AppBuildPluginBinding | null> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            this.logger.warn(
                `Build plugin resolution for work ${workId}: the Work does not exist.`,
            );
            return null;
        }

        if (!this.registry) {
            this.logger.error(
                `Build plugin resolution for work ${workId}: the plugin registry is not available in this injector, so no plugin can be resolved at all. This is a wiring fault, not a missing plugin.`,
            );
            return null;
        }

        const candidates = this.loadedBuildPlugins();
        if (candidates.length === 0) {
            this.logger.warn(
                `Build plugin resolution for work ${workId}: no loaded plugin declares the \`build\` capability.`,
            );
            return null;
        }
        if (candidates.length > 1) {
            // Refuse rather than pick. Two build plugins and no per-Work choice
            // means the platform would be deciding where a member's code is
            // built, silently.
            this.logger.error(
                `Build plugin resolution for work ${workId}: ${candidates.length} plugins declare the \`build\` capability (${candidates
                    .map((plugin) => plugin.id)
                    .join(', ')}) and an App Work has no way to choose between them yet. Refusing.`,
            );
            return null;
        }

        const plugin = candidates[0];
        const token = await this.tokenFor(workId, userId);
        if (!token) {
            this.logger.warn(
                `Build plugin resolution for work ${workId}: no provider credential is available for member ${userId}.`,
            );
            return null;
        }

        const auth: BuildAuth = { token };
        const repository = this.repositoryOf(work);
        const facts = await this.factsFor(workId);
        const repositoryRef = repository
            ? {
                  owner: repository.owner,
                  repo: repository.repo,
                  visibility: facts.visibility,
                  trackedBranch: repository.branch,
                  createdByAppWork: facts.createdByAppWork,
              }
            : null;

        const imageRepository = repository
            ? `ghcr.io/${repository.owner}/${repository.repo}/${APP_BUILD_IMAGE_NAME}`.toLowerCase()
            : null;

        return {
            pluginId: plugin.id,
            buildKind: plugin.buildKind,
            imageRepository,

            startBuild: async (input) => {
                if (!repositoryRef) return null;
                return plugin.startBuild(
                    {
                        workId,
                        buildId: input.buildId,
                        repository: repositoryRef,
                        ref: input.ref,
                        sha: input.sha,
                        mode: input.mode,
                        ...(input.reuseImageDigest
                            ? { reuseImageDigest: input.reuseImageDigest }
                            : {}),
                        ...(input.verification ? { verification: input.verification } : {}),
                        settings: {},
                    } as StartBuildInput,
                    auth,
                );
            },

            cancelBuild: async ({ buildId, providerRunId }) => {
                if (!repositoryRef || typeof plugin.cancelBuild !== 'function') return;
                await plugin.cancelBuild(
                    { repository: repositoryRef, buildId, providerRunId } as BuildRef,
                    auth,
                );
            },

            // APW-05 T14 — the registry read that confirms a Build's digest (plan
            // §4.8) and validates a pull token (§4.12). Declared only when the
            // plugin has the member AND the Work has an image to read, so a caller
            // that materialises it can rely on both.
            ...(imageRepository && typeof plugin.checkImageAccess === 'function'
                ? {
                      checkImageAccess: async (input: {
                          readonly imageRepository: string;
                          readonly tag: string;
                          readonly pullToken?: string;
                      }) => {
                          if (input.imageRepository.toLowerCase() !== imageRepository) {
                              // Work-bound, like every other member: the binding reads
                              // the image it resolved and no other. Refused before the
                              // pull token is sent anywhere.
                              throw new Error(
                                  `BuildFacadeService: ${input.imageRepository} is not this Work's image repository.`,
                              );
                          }
                          return plugin.checkImageAccess!({
                              imageRepository,
                              tag: input.tag,
                              ...(input.pullToken ? { pullToken: input.pullToken } : {}),
                          });
                      },
                  }
                : {}),
        };
    }

    /** Every loaded plugin declaring the `build` capability. */
    private loadedBuildPlugins(): IBuildPlugin[] {
        const all = this.registry?.getAll?.() ?? [];
        return all
            .filter(
                (registered) =>
                    registered?.state === 'loaded' &&
                    (registered.manifest?.capabilities ?? []).includes('build'),
            )
            .map((registered) => registered.plugin as unknown as IBuildPlugin)
            .filter(
                (plugin): plugin is IBuildPlugin =>
                    !!plugin && typeof plugin.startBuild === 'function' && !!plugin.buildKind,
            );
    }

    /**
     * The App Work's repository coordinates.
     *
     * The **Work Repository** (`website` role) is the one holding the app code
     * and therefore the one a Build builds — not the `data` role, whatever the
     * App Works plan's older prose calls "the data repository" (the owner's
     * repository-role note, `OWNER-ANSWERS §7.2`).
     */
    private repositoryOf(work: {
        getWebsiteRepo?: () => string;
        getRepoOwner?: (role: 'data' | 'work' | 'website') => string;
    }): { owner: string; repo: string; branch: string } | null {
        const owner = (work.getRepoOwner?.('website') ?? '').trim();
        const repo = (work.getWebsiteRepo?.() ?? '').trim();
        if (!owner || !repo) return null;
        // The tracked branch is APW-02's, on `WorkUpstreamState`; `Work` carries
        // none. `main` is the default until {@link BuildRepositoryFactsSource}
        // reports otherwise, which is where that column is read from.
        return { owner, repo, branch: 'main' };
    }

    /**
     * Visibility and provenance, which decide the runner class and whether a
     * workflow change may be pushed directly (R-4, plan §4.6 step 7).
     *
     * Neither is a `Work` column: the truth is APW-02's `WorkUpstreamState`
     * (`relation`) and the provider's repository record. With no source bound,
     * the defaults are the SAFE ones, not the convenient ones:
     *
     *  - `visibility: 'private'` — a private repository routed to a public
     *    runner is the failure that matters; a public one routed to the private
     *    runner is only slower;
     *  - `createdByAppWork: false` — a repository we did not create is not ours
     *    to write into, so the workflow change takes the pull-request path.
     *    Guessing `true` would push a commit to somebody else's repository.
     */
    private async factsFor(
        workId: string,
    ): Promise<{ visibility: 'public' | 'private'; createdByAppWork: boolean }> {
        if (!this.facts) return { visibility: 'private', createdByAppWork: false };
        try {
            const reported = await this.facts.getBuildRepositoryFacts({ workId });
            return {
                visibility: reported?.visibility ?? 'private',
                createdByAppWork: reported?.createdByAppWork ?? false,
            };
        } catch (error) {
            this.logger.warn(
                `Build plugin resolution for work ${workId}: the repository facts lookup failed (${
                    error instanceof Error ? error.message : String(error)
                }); taking the safe defaults.`,
            );
            return { visibility: 'private', createdByAppWork: false };
        }
    }

    /** The member's provider token, or `null` when none can be obtained. */
    private async tokenFor(workId: string, userId: string): Promise<string | null> {
        if (!this.tokens) return null;
        try {
            const token = await this.tokens.getBuildToken({ workId, userId, providerId: 'github' });
            return token && token.trim().length > 0 ? token : null;
        } catch (error) {
            // A credential lookup that throws is "no credential", not a crashed
            // Build request. The message is logged; the token never is.
            this.logger.warn(
                `Build plugin resolution for work ${workId}: the credential lookup failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }
}

/**
 * Where a member's provider token comes from.
 *
 * A one-method port rather than a direct dependency on the git facade: this
 * facade needs exactly one string, a fake is two lines, and the real binding
 * differs between the API process (member connections) and a worker (the
 * credential of record, `WorkUpstreamState.credentialMemberUserId`).
 */
export interface BuildTokenSource {
    getBuildToken(input: {
        readonly workId: string;
        readonly userId: string;
        readonly providerId: string;
    }): Promise<string | null>;
}

/**
 * Where the App Work's repository visibility and provenance come from.
 *
 * The truth is APW-02's `WorkUpstreamState.relation` plus the provider's
 * repository record, neither of which is a `Work` column and neither of which
 * this facade should reach for itself. A one-method port keeps the dependency
 * out and makes both halves of the answer testable.
 */
export interface BuildRepositoryFactsSource {
    getBuildRepositoryFacts(input: { readonly workId: string }): Promise<{
        readonly visibility: 'public' | 'private';
        readonly createdByAppWork: boolean;
    } | null>;
}
