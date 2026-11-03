/**
 * APW-03 T26 (the explicit and probe halves) — `AppBlueprintResolverService`.
 *
 * Resolves a repository to an App Blueprint on the two paths that need no catalog
 * manifest:
 *
 *  - **explicit** (FR-81): `blueprintId` given ⇒ `ever-works/<blueprintId>-template`,
 *    the naming `catalog.md` §5 fixes and all three live Blueprint repositories
 *    follow. There is no manifest entry to list the repository, so no ref check
 *    applies and the answer is never verified;
 *  - **probe** (FR-43, plan §2.5): `ever-works/<slug(repo)>-template`, then
 *    `ever-works/<slug(owner)>-<slug(repo)>-template`, at most
 *    {@link BLUEPRINT_PROBE_MAX_READS} provider reads, no free-text search.
 *
 * **Not implemented here** (still open in T24/T26): the manifest lookup, aliases,
 * rename re-lookup and the fork network. They need the listing's `manifest.json`
 * (`catalog.md` §3), whose live rows are all `status: placeholder` today.
 *
 * ## What a Blueprint is (both paths)
 *
 * A repository is accepted only when ALL of these hold (FR-43, `catalog.md` §5,
 * CONTRACTS §8):
 *
 *  1. the provider found it, and its resolved `fullName` is still under
 *     `ever-works/` — a rename or transfer out of the org is refused;
 *  2. it is **public** (`catalog.md` §5 "Required repository settings: public");
 *  3. its topics include {@link APP_BLUEPRINT_TOPIC};
 *  4. `.works/works.yml` on its default branch validates in `blueprint` mode with
 *     zero errors, its ROOT `kind` is `app` (the validator does not check the root
 *     kind), and `spec.blueprint.repo` names this very repository;
 *  5. the licence the Blueprint declares does not classify `red` (R-3).
 *
 * The explicit path additionally requires `spec.blueprint.id === blueprintId`.
 *
 * ## Credential
 *
 * The port input carries no user, so every read uses a **platform** credential:
 * the GitHub App installation on `ever-works`, then
 * `EVER_WORKS_APPS_CATALOG_TOKEN` (CONTRACTS §7), then `GITHUB_TOKEN` — the chain
 * `works-template-catalog.service.ts` already uses. None ⇒
 * {@link AppsCatalogCredentialUnavailableError}, which is never cached: "we could
 * not look" is not "there is no Blueprint".
 *
 * ## SSRF containment (plan §2.4)
 *
 * The only provider calls are `getRepository` and `getFileContent`, always on owner
 * `ever-works`, always on a repository name matching `^[a-z0-9][a-z0-9-]*$` built
 * here from a slug or a validated id, and always for {@link APP_BLUEPRINT_SPEC_PATH}.
 * Nothing the caller or the file supplies (upstreams, aliases, links) is ever
 * fetched.
 *
 * ## Cache (FR-44)
 *
 * In-process and bounded ({@link APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES}, oldest
 * evicted), keyed on the lower-cased `owner/repo` plus `:blueprintId`. A hit lives
 * {@link BLUEPRINT_RESOLVE_HIT_TTL_MS}, any `none` (including `lookupFailed`)
 * {@link BLUEPRINT_RESOLVE_MISS_TTL_MS}. Plan §2.5 names a `CACHE_MANAGER` key;
 * `AppWorksModule` has no cache module, and an in-process map keeps the same TTLs
 * without adding one.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    BLUEPRINT_PROBE_MAX_READS,
    BLUEPRINT_RESOLVE_HIT_TTL_MS,
    BLUEPRINT_RESOLVE_MISS_TTL_MS,
    type AppBlueprintPrompt,
    type AppSpec,
} from '@ever-works/contracts';
import type { GitRepositoryWithPermissions } from '@ever-works/plugin';
import { parse as parseYaml } from 'yaml';
import { classifyLicenseExpression } from '../app-license/license-classify';
// A VALUE import: Nest reads the constructor's parameter type from decorator
// metadata, and a type-only import would emit `Object` as the token.
import { GitFacadeService } from '../facades/git.facade';
import { validateAppSpecDocument } from '../works-config/schema/app-spec.validate';
import { APP_BLUEPRINT_TOPIC } from './app-blueprint.constants';
import {
    APP_SPEC_TELEMETRY_EVENTS,
    AppSpecTelemetry,
    type AppBlueprintResolvedSource,
} from '../app-spec/app-spec-telemetry.port';

// The topic lives in a dependency-free leaf so website-template discovery can
// recognise a Blueprint without importing this service; re-exported here so
// every existing `APP_BLUEPRINT_TOPIC` import keeps resolving.
export { APP_BLUEPRINT_TOPIC };

/** The only owner the resolver ever reads. */
export const APP_BLUEPRINT_OWNER = 'ever-works';

/** The only file the resolver ever reads (CONTRACTS §8, `catalog.md` §5). */
export const APP_BLUEPRINT_SPEC_PATH = '.works/works.yml';

/**
 * Who may be offered a **private** Blueprint (decision 2026-10-17, lane aw-catalog).
 *
 * Third-party sources only ever see PUBLIC Blueprints (`catalog.md` §5's rule, unchanged).
 * A private `ever-works/*-template` is first-party material — a fixture, a not-yet-public
 * Blueprint — and is offered only when the SOURCE repository being matched is owned by
 * `ever-works` itself, or by an owner the operator lists in
 * `EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS` (comma-separated, case-insensitive; `*` =
 * anyone, for a test installation only). That is what lets the APW-13 lanes resolve
 * `ever-works/app-fixture-hello-template` for `ever-works/app-fixture-hello` and for a
 * per-run generated upstream in the e2e org, while a stranger's repository can never pull
 * a private Blueprint's content into their fork.
 */
export function allowsPrivateBlueprint(sourceOwner: string | null | undefined): boolean {
    const owner = typeof sourceOwner === 'string' ? sourceOwner.trim().toLowerCase() : '';
    if (owner === '') {
        return false;
    }
    if (owner === APP_BLUEPRINT_OWNER) {
        return true;
    }
    const listed = (process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== '');
    // `*` is a test-installation convenience and is ignored in production, so a stray
    // wildcard can never offer first-party private Blueprints to every source.
    const wildcard = listed.includes('*') && process.env.NODE_ENV !== 'production';
    return wildcard || listed.includes(owner);
}

/** How many resolutions the in-process cache holds before evicting the oldest. */
export const APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES = 500;

/** A Blueprint id (schema.md §6:137 — the same pattern `spec.blueprint.id` has). */
const BLUEPRINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A repository name the resolver builds and is willing to read. */
const CANDIDATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** No platform credential can read the `ever-works` Blueprint repositories. */
export class AppsCatalogCredentialUnavailableError extends Error {
    constructor(
        message = 'No platform credential can read the ever-works Blueprint repositories ' +
            '(no GitHub App installation on ever-works, EVER_WORKS_APPS_CATALOG_TOKEN or GITHUB_TOKEN).',
    ) {
        super(message);
        this.name = 'AppsCatalogCredentialUnavailableError';
    }
}

export interface AppBlueprintResolveInput {
    owner: string;
    repo: string;
    blueprintId?: string;
}

/** A Blueprint the resolver accepted. Prompts are descriptors only — never a value or an example. */
export interface AppBlueprintResolveHit {
    status: 'hit';
    source: 'probe' | 'explicit';
    /** The Blueprint repository, as the provider resolved it (`ever-works/<name>`). */
    repo: string;
    id: string;
    version: string;
    /** `spec.display.name`, else the id. */
    name: string;
    displayName?: string;
    /** The licence the Blueprint DECLARES; classifying it is the adapter's job. */
    spdx?: string;
    prompts: AppBlueprintPrompt[];
}

/**
 * APW-03 T28 — a Blueprint together with its `.works/works.yml` text, for the apply
 * service only. Kept OUT of {@link AppBlueprintResolveHit} (and its cache) on purpose:
 * the document carries prompt examples, and FR-55 says no value or example ever
 * travels with a match.
 */
export interface AppBlueprintDocument {
    readonly hit: AppBlueprintResolveHit;
    readonly text: string;
    /** The Blueprint repository's default branch the text was read from. */
    readonly defaultBranch: string | null;
}

/**
 * APW-03 T28 (lane aw-blueprints) — one RELEASE of a Blueprint: its `.works/works.yml`
 * at a named version (the base and the target of an upgrade). Like
 * {@link AppBlueprintDocument} it is never cached and never travels with a match.
 */
export interface AppBlueprintRelease {
    readonly hit: AppBlueprintResolveHit;
    readonly text: string;
    /** What the text was read at: a `v<version>` / `<version>` tag, or a commit sha. */
    readonly ref: string;
    /** The commit sha, when the read named one (a sha ref, or the default branch's head). */
    readonly sha: string | null;
}

/**
 * The reads one {@link AppBlueprintResolverService.readBlueprintRelease} may make: the
 * repository, a pinned sha, two tag spellings, the default branch's head and its file.
 */
export const BLUEPRINT_RELEASE_MAX_READS = 6;

/** A version string the release read is willing to turn into a tag name. */
const RELEASE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** A full commit sha. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface AppBlueprintResolveMiss {
    status: 'none';
    reason: 'notListed' | 'lookupFailed' | 'blueprintNotFound';
}

export type AppBlueprintResolution = AppBlueprintResolveHit | AppBlueprintResolveMiss;

/** Lower-case; every run of anything but `[a-z0-9]` becomes one `-`; trimmed of `-`. */
function slug(value: string): string {
    return (value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * FR-43's two probe names, slugified, de-duplicated, and only those that can be a
 * repository name the resolver is willing to read.
 */
export function probeCandidateNames(owner: string, repo: string): string[] {
    const repoSlug = slug(repo);
    const ownerSlug = slug(owner);
    if (repoSlug === '') {
        return [];
    }
    const names = [`${repoSlug}-template`];
    if (ownerSlug !== '') {
        names.push(`${ownerSlug}-${repoSlug}-template`);
    }
    return [...new Set(names)].filter((name) => CANDIDATE_NAME_PATTERN.test(name));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstNonBlank(...values: Array<string | undefined>): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
    }
    return null;
}

/** Thrown when a read would exceed FR-43's cap; answered as `notListed`. */
class ReadBudgetExhausted extends Error {}

/** FR-43's provider-read counter. */
class ReadBudget {
    private used = 0;

    constructor(private readonly max: number) {}

    take(): void {
        if (this.used >= this.max) {
            throw new ReadBudgetExhausted();
        }
        this.used += 1;
    }

    /** Reads taken so far — `app.blueprint.resolved.providerReads` (APW-03 T49). */
    get reads(): number {
        return this.used;
    }
}

interface CacheEntry {
    readonly value: AppBlueprintResolution;
    readonly expiresAt: number;
}

@Injectable()
export class AppBlueprintResolverService {
    private readonly logger = new Logger(AppBlueprintResolverService.name);
    private readonly cache = new Map<string, CacheEntry>();

    constructor(
        // `@Optional()`: `AppWorksModule` is compiled bare by its own spec with
        // `FacadesModule` shelled, and an absent facade must answer "credential
        // unavailable", not `undefined.getRepository`.
        @Optional()
        private readonly gitFacade?: GitFacadeService,
        // APW-03 T49 — `app.blueprint.resolved`. `@Optional()` and appended LAST: absent,
        // nothing is emitted; present, it never throws.
        @Optional()
        private readonly telemetry?: AppSpecTelemetry,
    ) {}

    async resolve(input: AppBlueprintResolveInput): Promise<AppBlueprintResolution> {
        const startedAtMs = Date.now();
        const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
        const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
        const blueprintId = input.blueprintId;

        // A malformed id can name no repository: zero reads, nothing cached.
        if (blueprintId !== undefined && !BLUEPRINT_ID_PATTERN.test(blueprintId)) {
            return this.observeResolution(
                { status: 'none', reason: 'blueprintNotFound' },
                'explicit',
                startedAtMs,
                0,
            );
        }

        const key = `${owner}/${repo}`.toLowerCase() + (blueprintId ? `:${blueprintId}` : '');
        const cached = this.readCache(key);
        if (cached) {
            return this.observeResolution(cached, 'cache', startedAtMs, 0);
        }

        const facade = this.gitFacade;
        const token = facade ? await this.resolveToken(facade) : null;
        if (!facade || !token) {
            throw new AppsCatalogCredentialUnavailableError();
        }

        const budget = new ReadBudget(BLUEPRINT_PROBE_MAX_READS);
        let result: AppBlueprintResolution;
        try {
            result =
                blueprintId !== undefined
                    ? await this.resolveExplicit(
                          facade,
                          token,
                          blueprintId,
                          budget,
                          allowsPrivateBlueprint(owner),
                      )
                    : await this.resolveProbe(facade, token, owner, repo, budget);
        } catch (error) {
            if (error instanceof ReadBudgetExhausted) {
                result = { status: 'none', reason: 'notListed' };
            } else {
                // FR-44: a provider error is "none, lookupFailed" and never blocks a
                // create. Cached for the miss TTL, so it is logged at most once per
                // key per 10 minutes.
                this.logger.warn(
                    `Blueprint resolution for ${key} failed (${error instanceof Error ? error.message : String(error)}).`,
                );
                result = { status: 'none', reason: 'lookupFailed' };
            }
        }

        this.writeCache(key, result);
        return this.observeResolution(
            result,
            blueprintId !== undefined ? 'explicit' : 'probe',
            startedAtMs,
            budget.reads,
        );
    }

    /**
     * APW-03 T49 — `app.blueprint.resolved`: how the answer was reached, the outcome code and
     * the read count. Never the source repository, the Blueprint repository or a prompt.
     * Returns the resolution unchanged.
     */
    private observeResolution(
        result: AppBlueprintResolution,
        source: AppBlueprintResolvedSource,
        startedAtMs: number,
        providerReads: number,
    ): AppBlueprintResolution {
        const outcome: string = result.status === 'hit' ? 'hit' : result.reason;
        this.telemetry?.track(APP_SPEC_TELEMETRY_EVENTS.blueprintResolved, {
            source,
            outcome,
            // This resolver applies no ref constraint (the manifest path's `refMismatch`
            // belongs to the catalog), so it is the outcome code that says so, if ever.
            refMismatch: outcome === 'refMismatch',
            durationMs: Math.max(0, Date.now() - startedAtMs),
            providerReads,
        });
        return result;
    }

    /**
     * APW-03 T28 — the explicit path (FR-81) plus the document text, uncached, for the
     * apply service. The same acceptance rules and the same read budget as `resolve`;
     * `null` for any miss. Throws {@link AppsCatalogCredentialUnavailableError} when no
     * platform credential exists.
     */
    async readBlueprintDocument(
        blueprintId: string,
        opts: { sourceOwner?: string | null } = {},
    ): Promise<AppBlueprintDocument | null> {
        if (typeof blueprintId !== 'string' || !BLUEPRINT_ID_PATTERN.test(blueprintId)) {
            return null;
        }
        const facade = this.gitFacade;
        const token = facade ? await this.resolveToken(facade) : null;
        if (!facade || !token) {
            throw new AppsCatalogCredentialUnavailableError();
        }
        const budget = new ReadBudget(BLUEPRINT_PROBE_MAX_READS);
        try {
            const repository = await this.readRepository(
                facade,
                token,
                `${blueprintId}-template`,
                budget,
                allowsPrivateBlueprint(opts.sourceOwner),
            );
            if (!repository) {
                return null;
            }
            const read = await this.readBlueprintSpec(facade, token, repository, budget);
            if (!read || read.spec.blueprint?.id !== blueprintId) {
                return null;
            }
            return {
                hit: this.toHit('explicit', repository, read.spec),
                text: read.text,
                defaultBranch: repository.defaultBranch || null,
            };
        } catch (error) {
            if (error instanceof ReadBudgetExhausted) {
                return null;
            }
            this.logger.warn(
                `Reading Blueprint "${blueprintId}" failed (${error instanceof Error ? error.message : String(error)}).`,
            );
            return null;
        }
    }

    /**
     * APW-03 T28 (lane aw-blueprints) — the Blueprint's `.works/works.yml` at one
     * version, for the upgrade's base (the version applied) and target (the new one).
     *
     * Tried in order, first acceptable answer wins, every acceptance rule of the class
     * docstring applied at each ref:
     *
     *  1. `opts.sha` (a 40-hex commit the App Work recorded at apply time);
     *  2. the release tags `v<version>` then `<version>` (`ever-works/templates`'
     *     `release.yml` tags `vX.Y.Z`, `catalog.md` T33);
     *  3. the default branch's head, read AT its sha so text and sha agree.
     *
     * With a `version`, an answer must declare exactly that `spec.blueprint.version` —
     * a tag that moved, or a default branch already past it, is not that release. With
     * no version, the default branch's head is the latest release. `null` for every
     * miss; {@link AppsCatalogCredentialUnavailableError} when no platform credential
     * exists. Uncached: an upgrade is rare and must see the repository as it is now.
     */
    async readBlueprintRelease(
        blueprintId: string,
        opts: { sourceOwner?: string | null; version?: string | null; sha?: string | null } = {},
    ): Promise<AppBlueprintRelease | null> {
        if (typeof blueprintId !== 'string' || !BLUEPRINT_ID_PATTERN.test(blueprintId)) {
            return null;
        }
        const version =
            typeof opts.version === 'string' && RELEASE_VERSION_PATTERN.test(opts.version)
                ? opts.version
                : null;
        if (opts.version != null && version === null) {
            return null;
        }
        const facade = this.gitFacade;
        const token = facade ? await this.resolveToken(facade) : null;
        if (!facade || !token) {
            throw new AppsCatalogCredentialUnavailableError();
        }
        const budget = new ReadBudget(BLUEPRINT_RELEASE_MAX_READS);
        try {
            const repository = await this.readRepository(
                facade,
                token,
                `${blueprintId}-template`,
                budget,
                allowsPrivateBlueprint(opts.sourceOwner),
            );
            if (!repository) {
                return null;
            }
            const accept = (spec: AppSpec): boolean =>
                spec.blueprint?.id === blueprintId &&
                (version === null || spec.blueprint?.version === version);

            const refs: Array<{ ref: string; sha: string | null }> = [];
            if (typeof opts.sha === 'string' && COMMIT_SHA_PATTERN.test(opts.sha)) {
                refs.push({ ref: opts.sha, sha: opts.sha });
            }
            if (version !== null) {
                refs.push({ ref: `v${version}`, sha: null });
                refs.push({ ref: version, sha: null });
            }
            for (const candidate of refs) {
                const read = await this.readBlueprintSpec(
                    facade,
                    token,
                    repository,
                    budget,
                    candidate.ref,
                );
                if (read && accept(read.spec)) {
                    return {
                        hit: this.toHit('explicit', repository, read.spec),
                        text: read.text,
                        ref: candidate.ref,
                        sha: candidate.sha,
                    };
                }
            }

            const branch = repository.defaultBranch || null;
            if (!branch) {
                return null;
            }
            budget.take();
            const head = await facade.getLatestCommit(
                APP_BLUEPRINT_OWNER,
                repository.name,
                branch,
                {
                    token,
                    providerId: 'github',
                },
            );
            const headSha =
                typeof head?.sha === 'string' && COMMIT_SHA_PATTERN.test(head.sha)
                    ? head.sha
                    : null;
            const read = await this.readBlueprintSpec(
                facade,
                token,
                repository,
                budget,
                headSha ?? branch,
            );
            if (!read || !accept(read.spec)) {
                return null;
            }
            return {
                hit: this.toHit('explicit', repository, read.spec),
                text: read.text,
                ref: headSha ?? branch,
                sha: headSha,
            };
        } catch (error) {
            if (error instanceof ReadBudgetExhausted) {
                return null;
            }
            this.logger.warn(
                `Reading release ${opts.version ?? 'latest'} of Blueprint "${blueprintId}" failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /** FR-81: `ever-works/<blueprintId>-template`, and the file must name that id. */
    private async resolveExplicit(
        facade: GitFacadeService,
        token: string,
        blueprintId: string,
        budget: ReadBudget,
        allowPrivate: boolean,
    ): Promise<AppBlueprintResolution> {
        const repository = await this.readRepository(
            facade,
            token,
            `${blueprintId}-template`,
            budget,
            allowPrivate,
        );
        if (!repository) {
            return { status: 'none', reason: 'blueprintNotFound' };
        }
        const read = await this.readBlueprintSpec(facade, token, repository, budget);
        if (!read || read.spec.blueprint?.id !== blueprintId) {
            return { status: 'none', reason: 'blueprintNotFound' };
        }
        return this.toHit('explicit', repository, read.spec);
    }

    /** FR-43: two names at most, the first acceptable repository, then ONE file read. */
    private async resolveProbe(
        facade: GitFacadeService,
        token: string,
        owner: string,
        repo: string,
        budget: ReadBudget,
    ): Promise<AppBlueprintResolution> {
        let repository: GitRepositoryWithPermissions | null = null;
        for (const name of probeCandidateNames(owner, repo)) {
            repository = await this.readRepository(
                facade,
                token,
                name,
                budget,
                allowsPrivateBlueprint(owner),
            );
            if (repository) {
                break;
            }
        }
        if (!repository) {
            return { status: 'none', reason: 'notListed' };
        }
        const read = await this.readBlueprintSpec(facade, token, repository, budget);
        return read
            ? this.toHit('probe', repository, read.spec)
            : { status: 'none', reason: 'notListed' };
    }

    /**
     * One `getRepository` read, answered only when rules 1–3 hold (found, still in
     * the org, public, carries the topic). Anything else is `null`.
     */
    private async readRepository(
        facade: GitFacadeService,
        token: string,
        name: string,
        budget: ReadBudget,
        allowPrivate = false,
    ): Promise<GitRepositoryWithPermissions | null> {
        if (!CANDIDATE_NAME_PATTERN.test(name)) {
            return null;
        }
        budget.take();
        const repository = await facade.getRepository(APP_BLUEPRINT_OWNER, name, {
            token,
            providerId: 'github',
        });
        if (!repository || typeof repository.fullName !== 'string') {
            return null;
        }
        if (!repository.fullName.toLowerCase().startsWith(`${APP_BLUEPRINT_OWNER}/`)) {
            return null;
        }
        const isPublic =
            repository.isPrivate !== true &&
            (repository.visibility === undefined || repository.visibility === 'public');
        // Public, or private and first-party for this source (see `allowsPrivateBlueprint`).
        if (!isPublic && !allowPrivate) {
            return null;
        }
        if (!Array.isArray(repository.topics) || !repository.topics.includes(APP_BLUEPRINT_TOPIC)) {
            return null;
        }
        return repository;
    }

    /**
     * One `getFileContent` read of `.works/works.yml` on the default branch, answered
     * only when rules 4–5 hold. Anything else is `null`.
     */
    private async readBlueprintSpec(
        facade: GitFacadeService,
        token: string,
        repository: GitRepositoryWithPermissions,
        budget: ReadBudget,
        // APW-03 T28 (lane aw-blueprints) — a tag or commit to read instead of the
        // default branch. Every acceptance rule below applies at that ref unchanged.
        atRef?: string,
    ): Promise<{ spec: AppSpec; text: string } | null> {
        budget.take();
        const ref = atRef || repository.defaultBranch || undefined;
        const file = await facade.getFileContent(
            APP_BLUEPRINT_OWNER,
            repository.name,
            APP_BLUEPRINT_SPEC_PATH,
            { token, providerId: 'github' },
            ref,
        );
        // Only `.works/works.yml` (owner decision 2026-09-25: fix the repositories, not
        // the contract — a Blueprint whose spec lives elsewhere is moved, never followed).
        const text = file?.content;
        if (typeof text !== 'string' || text.trim() === '') {
            return null;
        }

        const validation = validateAppSpecDocument(text, { mode: 'blueprint' });
        if (validation.errorCount !== 0 || validation.spec === null) {
            return null;
        }

        // The validator reads the `spec` block; the ROOT kind is not one of its rules,
        // and `kind: directory` with an empty spec validates clean.
        let root: unknown;
        try {
            root = parseYaml(text);
        } catch {
            return null;
        }
        if (!isPlainObject(root) || root.kind !== 'app') {
            return null;
        }

        const spec = validation.spec;
        const blueprint = spec.blueprint;
        if (!blueprint || blueprint.repo.toLowerCase() !== repository.fullName.toLowerCase()) {
            return null;
        }
        if (classifyLicenseExpression(spec.license?.spdx) === 'red') {
            return null;
        }
        return { spec, text };
    }

    private toHit(
        source: AppBlueprintResolveHit['source'],
        repository: GitRepositoryWithPermissions,
        spec: AppSpec,
    ): AppBlueprintResolveHit {
        // `readBlueprintSpec` refused a spec without one.
        const blueprint = spec.blueprint!;
        const displayName = firstNonBlank(spec.display?.name) ?? undefined;
        const spdx = firstNonBlank(spec.license?.spdx) ?? undefined;
        const prompts: AppBlueprintPrompt[] = [];
        for (const entry of spec.env ?? []) {
            const prompt = entry?.prompt;
            if (!prompt) {
                continue;
            }
            // Descriptors only: `example`, `group`, values and generators never travel.
            prompts.push({
                name: entry.name,
                ...(firstNonBlank(prompt.description) ? { description: prompt.description } : {}),
                required: prompt.required ?? true,
            });
        }
        return {
            status: 'hit',
            source,
            repo: repository.fullName,
            id: blueprint.id,
            version: blueprint.version,
            name: displayName ?? blueprint.id,
            ...(displayName ? { displayName } : {}),
            ...(spdx ? { spdx } : {}),
            prompts,
        };
    }

    /** Installation token on `ever-works`, then the two environment tokens. */
    private async resolveToken(facade: GitFacadeService): Promise<string | null> {
        let installation: string | null = null;
        try {
            installation = await facade.getInstallationTokenForOwner(APP_BLUEPRINT_OWNER);
        } catch {
            installation = null;
        }
        return firstNonBlank(
            installation ?? undefined,
            process.env.EVER_WORKS_APPS_CATALOG_TOKEN,
            process.env.GITHUB_TOKEN,
        );
    }

    private readCache(key: string): AppBlueprintResolution | undefined {
        const entry = this.cache.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.value;
    }

    private writeCache(key: string, value: AppBlueprintResolution): void {
        const ttl =
            value.status === 'hit' ? BLUEPRINT_RESOLVE_HIT_TTL_MS : BLUEPRINT_RESOLVE_MISS_TTL_MS;
        this.cache.delete(key);
        while (this.cache.size >= APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.cache.delete(oldest);
        }
        this.cache.set(key, { value, expiresAt: Date.now() + ttl });
    }
}
