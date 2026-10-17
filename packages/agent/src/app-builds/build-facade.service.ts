import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_BUILD_IMAGE_NAME,
    APP_BUILD_WORKFLOW_PATH,
    type AppBuildKind,
} from '@ever-works/contracts';
import type {
    BuildAuth,
    BuildRef,
    BuildRepositoryRef,
    BuildRunRef,
    BuildSnapshot,
    IBuildPlugin,
    PrepareRepositoryInput,
    PrepareRepositoryResult,
    RepositoryWriter,
    StartBuildInput,
} from '@ever-works/plugin';

import { WorkRepository } from '../database/repositories/work.repository';
import {
    loadRegisteredPlugins,
    PluginRegistryService,
} from '../plugins/services/plugin-registry.service';
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

/** DI token for {@link BuildSettingsSource}. Declared here for the same reason. */
export const BUILD_SETTINGS_SOURCE = Symbol('BUILD_SETTINGS_SOURCE');

/**
 * The full binding {@link BuildFacadeService.resolve} answers (2026-10-17,
 * outstanding-work A0.4, ledger D19).
 *
 * `AppBuildPluginBinding` is what `AppBuildsService` calls; the prepare runner,
 * the watch runner and run discovery each declared the further members they
 * need (`repository`, `settings`, `auth`, `writer`, `prepareRepository`,
 * `getBuild`, `listRecentRuns`) as a provisional widening "until T16 lands". Until
 * this date the facade supplied none of them, so a real prepare and a real watch
 * both answered `pluginUnavailable` — no Build could run or be observed. This is
 * that widening, supplied.
 */
export interface BuildFacadeBinding extends AppBuildPluginBinding {
    readonly repository?: BuildRepositoryRef;
    readonly settings?: Record<string, unknown>;
    /** The resolved git credential. Never logged, never stored, never returned over HTTP. */
    readonly auth?: BuildAuth;
    readonly writer?: RepositoryWriter;
    prepareRepository?(
        input: PrepareRepositoryInput,
        auth?: { readonly token: string },
        writer?: RepositoryWriter,
    ): Promise<PrepareRepositoryResult>;
    getBuild?(
        ref: BuildRef,
        auth: BuildAuth,
        redact: (text: string) => string,
    ): Promise<BuildSnapshot | null>;
    listRecentRuns?(input: {
        readonly perPage: number;
        readonly etag?: string;
    }): Promise<{ notModified: boolean; etag?: string; runs: BuildRunRef[] }>;
    deleteVerifyPromptedSecret?(): Promise<unknown>;
}

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
         *
         * `@Inject(PluginRegistryService)` is load-bearing, not decoration: the
         * `| undefined` makes SWC (`nest build -b swc`, what ships) emit `Object`
         * as this parameter's `design:paramtypes` entry, while tsc (ts-jest) emits
         * the class. Without the explicit token the running API resolved
         * `Object`, found nothing, and — the parameter being `@Optional()` —
         * built the facade with NO registry, while every spec saw one.
         * `__tests__/build-facade.registry-token.spec.ts` pins it.
         */
        @Optional()
        @Inject(PluginRegistryService)
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
        /**
         * Plan §4.4's resolved Work-scoped settings of the build plugin (the
         * larger-runner keys, the generator's switches, the pull token).
         * `@Optional()` and last; absent, the binding carries `{}` — the schema's
         * defaults, which build on the public runner.
         */
        @Optional()
        @Inject(BUILD_SETTINGS_SOURCE)
        private readonly settingsSource?: BuildSettingsSource,
    ) {}

    /**
     * The App Work's build plugin, or `null`.
     *
     * Every refusal is logged with its reason and answers `null`; none throws.
     * The callers treat a `null` as `pluginUnavailable`, which is a Build that
     * does not start rather than one that half-starts.
     */
    async resolve(workId: string, userId: string): Promise<BuildFacadeBinding | null> {
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

        const candidates = await this.loadedBuildPlugins();
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
        const auth = await this.authFor(workId, userId);
        if (!auth) {
            this.logger.warn(
                `Build plugin resolution for work ${workId}: no provider credential is available for member ${userId}.`,
            );
            return null;
        }
        const repository = this.repositoryOf(work);
        const facts = await this.factsFor(workId);
        const repositoryRef: BuildRepositoryRef | null = repository
            ? {
                  owner: repository.owner,
                  repo: repository.repo,
                  visibility: facts.visibility,
                  // APW-03's `WorkAppSpecState.trackedBranch` when the facts source
                  // knows it; `repositoryOf`'s `main` only as the last resort.
                  trackedBranch: facts.trackedBranch ?? repository.branch,
                  createdByAppWork: facts.createdByAppWork,
              }
            : null;
        const settings = await this.settingsFor(plugin.id, workId, userId);
        // The plugin's own clone-free writer when it has one (see
        // `IBuildPlugin.repositoryWriter?`); without it there is no writer, and the
        // prepare runner answers `pluginUnavailable` rather than half-preparing.
        const writer =
            repositoryRef && typeof plugin.repositoryWriter === 'function'
                ? plugin.repositoryWriter(
                      {
                          owner: repositoryRef.owner,
                          repo: repositoryRef.repo,
                          trackedBranch: repositoryRef.trackedBranch,
                      },
                      auth,
                  )
                : null;

        const imageRepository = repository
            ? `ghcr.io/${repository.owner}/${repository.repo}/${APP_BUILD_IMAGE_NAME}`.toLowerCase()
            : null;

        return {
            pluginId: plugin.id,
            ...(typeof plugin.name === 'string' ? { name: plugin.name } : {}),
            buildKind: plugin.buildKind,
            imageRepository,
            settings,
            auth,
            ...(repositoryRef ? { repository: repositoryRef } : {}),
            ...(writer ? { writer } : {}),

            // §4.6 — deliver the workflow and the build values. Work-bound: the
            // facade's credential and writer, whatever the caller passes.
            ...(repositoryRef && writer
                ? {
                      prepareRepository: async (
                          input: PrepareRepositoryInput,
                          _auth?: { readonly token: string },
                          writerOverride?: RepositoryWriter,
                      ) =>
                          plugin.prepareRepository(
                              {
                                  ...input,
                                  // Work-bound: always the resolved repository, never
                                  // one a caller names (the runner passes the same).
                                  repository: repositoryRef,
                                  settings: { ...settings, ...(input.settings ?? {}) },
                              },
                              auth,
                              writerOverride ?? writer,
                          ),
                  }
                : {}),

            // §7.3 — one observation. The ref's repository is replaced with the
            // resolved one, so a caller cannot observe somebody else's runs.
            ...(repositoryRef && typeof plugin.getBuild === 'function'
                ? {
                      getBuild: async (
                          ref: BuildRef,
                          _auth: BuildAuth,
                          redact: (text: string) => string,
                      ) => plugin.getBuild({ ...ref, repository: repositoryRef }, auth, redact),
                  }
                : {}),

            // §7.4a — run discovery, when the plugin can list its runs.
            ...(repositoryRef && typeof plugin.listRecentRuns === 'function'
                ? {
                      listRecentRuns: async (input: {
                          readonly perPage: number;
                          readonly etag?: string;
                      }) =>
                          plugin.listRecentRuns!(
                              {
                                  repository: {
                                      owner: repositoryRef.owner,
                                      name: repositoryRef.repo,
                                  },
                                  workflowPath: APP_BUILD_WORKFLOW_PATH,
                                  perPage: input.perPage,
                                  ...(input.etag ? { etag: input.etag } : {}),
                              },
                              auth,
                          ),
                  }
                : {}),

            // Plan §5 — a Rebuild's `commitSha` must be in the tracked branch's history.
            ...(repositoryRef && typeof plugin.isCommitReachable === 'function'
                ? {
                      isCommitReachable: async (sha: string) =>
                          plugin.isCommitReachable!(
                              {
                                  repository: {
                                      owner: repositoryRef.owner,
                                      repo: repositoryRef.repo,
                                  },
                                  sha,
                                  branch: repositoryRef.trackedBranch,
                              },
                              auth,
                          ),
                  }
                : {}),

            // §4.10 — the per-run prompted-value secret's removal (the watch runner's
            // terminal transition, and the sweep's orphan pass).
            ...(repositoryRef && typeof plugin.deleteVerifyPromptedSecret === 'function'
                ? {
                      deleteVerifyPromptedSecret: async () =>
                          plugin.deleteVerifyPromptedSecret!(
                              { owner: repositoryRef.owner, repo: repositoryRef.repo },
                              auth,
                          ),
                  }
                : {}),

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
                        settings,
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

    /**
     * Every loaded plugin declaring the `build` capability, LOADED FOR USE before anything
     * reads it.
     *
     * The load is not optional: disk built-ins stay cold lazy proxies until used
     * (`plugin-bootstrap.service.ts`), and a cold proxy answers a member its manifest does not
     * carry — `buildKind`, `checkImageAccess` — with an async forwarding wrapper (a function).
     * Read cold, the shape filter below would pass any plugin declaring `build`, and
     * `buildKind` would be that function instead of the string `evaluateBuildVerdict` compares
     * with `'apps-builder'` to decide whether a signature is required.
     * `loadRegisteredPlugins` imports each candidate, waits for its `onLoad`, and leaves out one
     * that cannot load — as a boot-time load failure would have been — so the count that
     * {@link resolve} refuses on is a count of usable plugins.
     * `__tests__/build-facade.cold-plugin.spec.ts` pins it.
     */
    private async loadedBuildPlugins(): Promise<IBuildPlugin[]> {
        const all = this.registry?.getAll?.() ?? [];
        const declared = all.filter(
            (registered) =>
                registered?.state === 'loaded' &&
                (registered.manifest?.capabilities ?? []).includes('build'),
        );
        const usable = await loadRegisteredPlugins(declared);
        return usable
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
    private async factsFor(workId: string): Promise<{
        visibility: 'public' | 'private';
        createdByAppWork: boolean;
        trackedBranch?: string;
    }> {
        if (!this.facts) return { visibility: 'private', createdByAppWork: false };
        try {
            const reported = await this.facts.getBuildRepositoryFacts({ workId });
            const trackedBranch =
                typeof reported?.trackedBranch === 'string' ? reported.trackedBranch.trim() : '';
            return {
                visibility: reported?.visibility ?? 'private',
                createdByAppWork: reported?.createdByAppWork ?? false,
                ...(trackedBranch ? { trackedBranch } : {}),
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

    /** The build plugin's resolved Work settings, `{}` when they cannot be read. Never logged. */
    private async settingsFor(
        pluginId: string,
        workId: string,
        userId: string,
    ): Promise<Record<string, unknown>> {
        if (!this.settingsSource) return {};
        try {
            return (await this.settingsSource.getBuildSettings({ pluginId, workId, userId })) ?? {};
        } catch (error) {
            this.logger.warn(
                `Build plugin resolution for work ${workId}: the settings read failed (${
                    error instanceof Error ? error.message : String(error)
                }); the schema defaults apply.`,
            );
            return {};
        }
    }

    /**
     * The Build's `BuildAuth`: the token, plus its kind and scopes when the
     * source can say (2026-10-17) — what lets the plugin name a missing
     * `workflow` scope instead of passing GitHub's 403/404 through.
     */
    private async authFor(workId: string, userId: string): Promise<BuildAuth | null> {
        if (this.tokens?.getBuildCredential) {
            try {
                const found = await this.tokens.getBuildCredential({
                    workId,
                    userId,
                    providerId: 'github',
                });
                if (found && found.token.trim().length > 0) {
                    return {
                        token: found.token,
                        credential: found.credential,
                        scopes: found.scopes,
                    };
                }
            } catch (error) {
                this.logger.warn(
                    `Build plugin resolution for work ${workId}: the credential lookup failed (${
                        error instanceof Error ? error.message : String(error)
                    }).`,
                );
            }
            // Fall through to the plain token read: an older source answering
            // only `getBuildToken` must keep working.
        }
        const token = await this.tokenFor(workId, userId);
        return token ? { token } : null;
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
    /**
     * The credential and what it is (2026-10-17). Optional: a source without it
     * is read through `getBuildToken` and the plugin learns nothing about the
     * credential's kind, which is how every source behaved before.
     */
    getBuildCredential?(input: {
        readonly workId: string;
        readonly userId: string;
        readonly providerId: string;
    }): Promise<BuildCredential | null>;
}

/** A Build credential with its kind and (when recorded) its OAuth scopes. Never logged. */
export interface BuildCredential {
    readonly token: string;
    readonly credential: 'oauth' | 'githubApp' | 'pat';
    readonly scopes: readonly string[] | null;
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
        /** APW-03's `WorkAppSpecState.trackedBranch`, when known (2026-10-17). */
        readonly trackedBranch?: string | null;
    } | null>;
}

/**
 * Where the build plugin's resolved Work settings come from (plan §4.4).
 *
 * A port for the same reason as the two above: the real answer is
 * `PluginSettingsService.getResolvedSettings`, which lives in the `@Global()`
 * plugins module this module cannot import standalone. Secrets are included —
 * the plugin needs the pull token — and the value never leaves the process.
 */
export interface BuildSettingsSource {
    getBuildSettings(input: {
        readonly pluginId: string;
        readonly workId: string;
        readonly userId: string;
    }): Promise<Record<string, unknown> | null>;
}
