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

// The topic lives in a dependency-free leaf so website-template discovery can
// recognise a Blueprint without importing this service; re-exported here so
// every existing `APP_BLUEPRINT_TOPIC` import keeps resolving.
export { APP_BLUEPRINT_TOPIC };

/** The only owner the resolver ever reads. */
export const APP_BLUEPRINT_OWNER = 'ever-works';

/** The only file the resolver ever reads (CONTRACTS §8, `catalog.md` §5). */
export const APP_BLUEPRINT_SPEC_PATH = '.works/works.yml';

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
    ) {}

    async resolve(input: AppBlueprintResolveInput): Promise<AppBlueprintResolution> {
        const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
        const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
        const blueprintId = input.blueprintId;

        // A malformed id can name no repository: zero reads, nothing cached.
        if (blueprintId !== undefined && !BLUEPRINT_ID_PATTERN.test(blueprintId)) {
            return { status: 'none', reason: 'blueprintNotFound' };
        }

        const key = `${owner}/${repo}`.toLowerCase() + (blueprintId ? `:${blueprintId}` : '');
        const cached = this.readCache(key);
        if (cached) {
            return cached;
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
                    ? await this.resolveExplicit(facade, token, blueprintId, budget)
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
        return result;
    }

    /** FR-81: `ever-works/<blueprintId>-template`, and the file must name that id. */
    private async resolveExplicit(
        facade: GitFacadeService,
        token: string,
        blueprintId: string,
        budget: ReadBudget,
    ): Promise<AppBlueprintResolution> {
        const repository = await this.readRepository(
            facade,
            token,
            `${blueprintId}-template`,
            budget,
        );
        if (!repository) {
            return { status: 'none', reason: 'blueprintNotFound' };
        }
        const spec = await this.readBlueprintSpec(facade, token, repository, budget);
        if (!spec || spec.blueprint?.id !== blueprintId) {
            return { status: 'none', reason: 'blueprintNotFound' };
        }
        return this.toHit('explicit', repository, spec);
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
            repository = await this.readRepository(facade, token, name, budget);
            if (repository) {
                break;
            }
        }
        if (!repository) {
            return { status: 'none', reason: 'notListed' };
        }
        const spec = await this.readBlueprintSpec(facade, token, repository, budget);
        return spec
            ? this.toHit('probe', repository, spec)
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
        if (!isPublic) {
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
    ): Promise<AppSpec | null> {
        budget.take();
        const file = await facade.getFileContent(
            APP_BLUEPRINT_OWNER,
            repository.name,
            APP_BLUEPRINT_SPEC_PATH,
            { token, providerId: 'github' },
            repository.defaultBranch || undefined,
        );
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
        return spec;
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
