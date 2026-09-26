import { Logger } from '@nestjs/common';
import * as path from 'node:path';
import YAML from 'yaml';

import { AgentAvatarMode, AgentIdleBehavior } from '../entities/agent.entity';
import type { GitFacadeService } from '../facades/git.facade';
import type { AgentGuardrails } from './guardrails';

/**
 * Repo-backed Agent templates — APW-04 T2 (plan §7.1, blocker 4).
 *
 * `AgentTemplatesService.createFromTemplate` instantiates the IN-CODE presets
 * in `agent-templates.ts` only; the `ever-works/agents` catalog is list-only
 * (`apps/api/src/agents/agent-template-catalog.service.ts`). ADR-014 forbids
 * adding the App Provisioner as an in-code preset, so this module is the read
 * half of the missing path: it fetches a catalog template's files at a pinned
 * ref and turns them into data the platform can instantiate.
 *
 * Three rules shape everything here, because the input is a file in a
 * DIFFERENT repository that the platform does not review:
 *
 *  1. **Read the public catalog the way the catalog service does.** Same
 *     owner/repo/ref convention, same tokenless-raw-then-App-installation
 *     fallback (`agent-template-catalog.service.ts:166-206`), same 10 s
 *     fail-closed deadline on the raw read
 *     (`apps/api/src/organizations/org-template-catalog.service.ts:89-108`).
 *  2. **Fail closed, never guess.** A missing or unknown manifest key, an
 *     unreadable file, a slug outside the allow-list or a path that does not
 *     resolve inside the template directory is a REFUSAL with a code — not a
 *     default, and not an exception thrown from a parser.
 *  3. **The catalog can describe an Agent; it can never widen one.** Text
 *     fields are HTML-stripped and length-capped before they reach a column,
 *     a prompt or a UI, and permissions are always ALL FALSE no matter what
 *     the manifest says (the manifest's own flag names are validated, never
 *     applied — see `createFromRepoTemplate`).
 *
 * The parse half is pure and exported for tests; only `read(...)` does I/O.
 */

/** Owner/repo of the Agent catalog — matches the API-side catalog service. */
export const AGENTS_CATALOG_OWNER = 'ever-works';
export const AGENTS_CATALOG_REPO = 'agents';

/**
 * The ONLY slugs this monorepo may instantiate from the catalog in P1
 * (plan §7.1). Widening this list is a separate, reviewed decision — the
 * App Provisioner is the one Agent this epic must create server-side.
 */
export const REPO_TEMPLATE_INSTANTIABLE_SLUGS = ['app-provisioner'] as const;

/** Manifest contract version this reader understands (`schemaVersion: 1`). */
export const REPO_AGENT_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Review-before-act, hard-coded for repo templates: an instantiated catalog
 * Agent proposes and a human decides. Deliberately NOT read from the
 * manifest — a catalog file must not be able to hand itself autonomy.
 */
export const REPO_TEMPLATE_GUARDRAILS: AgentGuardrails = Object.freeze({
    mode: 'require_approval',
});

/** Cap for every text field taken from the catalog (see `stripTemplateHtml`). */
export const REPO_AGENT_TEMPLATE_CAPS = {
    slug: 64,
    name: 120,
    title: 120,
    summary: 500,
    capabilities: 2_000,
    citationPolicy: 60,
    icon: 60,
    filePath: 200,
    /**
     * Below `AgentFileService`'s 64 KB per-file write cap
     * (`agent-file.service.ts:35`) so a catalog SOUL can never fail the write
     * on size — it is truncated to fit instead.
     */
    soul: 60_000,
} as const;

/** Collection bounds — a catalog manifest cannot make a create unbounded. */
export const REPO_AGENT_TEMPLATE_LIMITS = {
    tags: 20,
    seedPaths: 50,
    suggestedSkills: 50,
    tasks: 20,
    requiredSkills: 50,
} as const;

/** The companion files every template directory must carry (T2, §7.1). */
export const REPO_AGENT_TEMPLATE_MANIFEST_PATH = '.works/agent.yml';
export const REPO_AGENT_TEMPLATE_SKILLS_PATH = 'skills.yml';

/** Every TOP-LEVEL key the manifest must declare, exactly (plan §7.1). */
export const REPO_AGENT_TEMPLATE_REQUIRED_KEYS = [
    'schemaVersion',
    'slug',
    'name',
    'title',
    'scope',
    'summary',
    'capabilities',
    'avatarMode',
    'avatarIcon',
    'permissions',
    'heartbeatCadence',
    'idleBehavior',
    'suggestedSkills',
    'kb',
    'prompts',
    'soul',
    'tags',
] as const;

/** Keys each nested object must declare, exactly. */
export const REPO_AGENT_TEMPLATE_REQUIRED_KB_KEYS = ['seedPaths', 'citationPolicy'] as const;
export const REPO_AGENT_TEMPLATE_REQUIRED_PROMPT_KEYS = ['system', 'tasks'] as const;
export const REPO_AGENT_TEMPLATE_REQUIRED_TASK_KEYS = ['id', 'title', 'path'] as const;

/** `scope` values the catalog manifest may declare (plan §7.1). */
export const REPO_AGENT_TEMPLATE_SCOPES = ['PERSONAL', 'TENANT', 'PLATFORM'] as const;

export type RepoAgentTemplateScope = (typeof REPO_AGENT_TEMPLATE_SCOPES)[number];

/**
 * Why a read refused. Every code maps to one legible sentence in
 * {@link RepoAgentTemplateRefusal.message}; nothing here carries file
 * CONTENT (a refusal must never echo repository text back to a caller or a
 * log).
 */
export type RepoAgentTemplateRefusalCode =
    | 'template-not-found'
    | 'slug-not-instantiable'
    | 'manifest-yaml'
    | 'manifest-key-missing'
    | 'manifest-key-unknown'
    | 'manifest-invalid'
    | 'manifest-path-unsafe'
    | 'soul-unreadable'
    | 'skills-unreadable'
    | 'skills-invalid';

export interface RepoAgentTemplateRefusal {
    readonly status: 'refused';
    readonly code: RepoAgentTemplateRefusalCode;
    readonly message: string;
}

/** A validated manifest plus the files an instantiation needs. */
export interface RepoAgentTemplate {
    readonly slug: string;
    readonly ref: string;
    /** HTML-stripped, length-capped display name (`name`). */
    readonly name: string;
    readonly title: string;
    readonly summary: string;
    /** HTML-stripped, length-capped capabilities paragraph. */
    readonly capabilities: string;
    readonly scope: RepoAgentTemplateScope;
    readonly avatarMode: string;
    readonly avatarIcon: string;
    readonly tags: readonly string[];
    /** Catalog Skill slugs the template recommends (never applied here). */
    readonly suggestedSkills: readonly string[];
    /** Skill slugs `skills.yml` requires — non-empty by validation. */
    readonly requiredSkills: readonly string[];
    readonly recommendedSkills: readonly string[];
    /** HTML-stripped, length-capped `soul` file body, ready for SOUL.md. */
    readonly soul: string;
    /** Repository-relative paths, validated to stay inside the template. */
    readonly soulPath: string;
    readonly systemPromptPath: string;
    readonly taskPaths: readonly {
        readonly id: string;
        readonly title: string;
        readonly path: string;
    }[];
    readonly seedPaths: readonly string[];
    readonly citationPolicy: string;
}

export type RepoAgentTemplateReadResult =
    | { readonly status: 'ok'; readonly template: RepoAgentTemplate }
    | RepoAgentTemplateRefusal;

/**
 * Raised by an instantiation when the catalog refuses a template.
 *
 * A distinct type — not a Nest HTTP exception — because the caller is
 * `AppProvisionerAgentResolver` (plan §7.1), which turns any refusal into
 * readiness `agentTemplate: false`; the `code` is what that readiness note
 * names. `name` is set explicitly (a `GitProviderRequestError`-style class
 * that only sets `message` is invisible to `error.name` checks).
 */
export class RepoAgentTemplateRefusedError extends Error {
    readonly code: RepoAgentTemplateRefusalCode;
    readonly slug: string;

    constructor(slug: string, refusal: RepoAgentTemplateRefusal) {
        super(
            `Agent template "${slug}" could not be instantiated (${refusal.code}): ${refusal.message}`,
        );
        this.name = 'RepoAgentTemplateRefusedError';
        this.code = refusal.code;
        this.slug = slug;
    }
}

/** Parsed `skills.yml`: what the Agent needs bound to work at all. */
export interface RepoAgentTemplateSkills {
    readonly required: readonly string[];
    readonly recommended: readonly string[];
}

export type RepoAgentTemplateSkillsParseResult =
    | { readonly status: 'ok'; readonly skills: RepoAgentTemplateSkills }
    | RepoAgentTemplateRefusal;

/** One catalog file read. */
export interface RepoAgentTemplateFileRequest {
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
    readonly path: string;
}

/**
 * Where catalog files come from. Two legs, in the order the catalog service
 * uses them: an authenticated read (GitHub App installation on the org, else
 * an env token) and a tokenless raw read of the public repository. Both
 * return `null` for "absent or unreadable" — absence is a refusal, not a
 * throw.
 */
export interface RepoAgentTemplateSource {
    readAuthenticated(request: RepoAgentTemplateFileRequest): Promise<string | null>;
    readPublicRaw(request: RepoAgentTemplateFileRequest): Promise<string | null>;
}

/** Ref is validated before it is interpolated into a URL (see the mirror). */
const SAFE_CATALOG_REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** Slug allow-list pattern, same shape the API-side catalog uses. */
const SAFE_CATALOG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** HTML tag pattern — the catalog service's stripper, applied to our fields. */
const HTML_TAG_RE = /<[^>]*>/g;

const RAW_CATALOG_BASE = 'https://raw.githubusercontent.com';

const RAW_READ_TIMEOUT_MS = 10_000;

/** `ever-works/agents` ref — a pinned SHA or tag is the safe setting. */
export function resolveAgentsCatalogRef(): string {
    return process.env.EVER_WORKS_AGENTS_REF || 'main';
}

/** A ref that cannot move under a cache: a 40-hex SHA or a `vX.Y.Z` tag. */
export function isPinnedCatalogRef(ref: string): boolean {
    return /^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+(\.\d+)?$/.test(ref);
}

export function isInstantiableRepoAgentTemplateSlug(slug: string): boolean {
    return (REPO_TEMPLATE_INSTANTIABLE_SLUGS as readonly string[]).includes(slug);
}

/**
 * Drop HTML tags from a catalog string.
 *
 * Mirrors the catalog service's `stripHtml`
 * (`apps/api/src/agents/agent-template-catalog.service.ts:68-70`): a
 * compromised catalog repository must not be able to inject markup into a
 * value the web UI renders (an Agent name, title, capability summary) or into
 * an instruction file the model reads.
 */
export function stripTemplateHtml(value: string): string {
    return typeof value === 'string' ? value.replace(HTML_TAG_RE, '') : '';
}

/** HTML-strip + trim + cap. The single gate every catalog string passes. */
export function capTemplateText(value: unknown, maxLength: number): string {
    return stripTemplateHtml(typeof value === 'string' ? value : '')
        .trim()
        .slice(0, maxLength);
}

/**
 * Path confinement for every path a manifest names.
 *
 * Mirrors `isSafeSeedPath` in
 * `packages/agent/src/missions/mission-template-manifest.service.ts:84-104`,
 * which exists for the same reason: the value comes from a repository we do
 * not review, and it is later used to read a file OUT of that repository.
 * Everything that could leave the template directory — an absolute path, a
 * drive letter, a backslash, a null byte, or any `..` segment after POSIX
 * normalisation — is refused.
 */
export function isSafeTemplatePath(value: string): boolean {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > REPO_AGENT_TEMPLATE_CAPS.filePath
    ) {
        return false;
    }
    if (value.includes('\\') || value.includes('\0')) {
        return false;
    }
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
        return false;
    }

    const normalized = path.posix.normalize(value);
    if (normalized.startsWith('../') || normalized.split('/').some((segment) => segment === '..')) {
        return false;
    }

    return normalized !== '.' && !normalized.startsWith('/');
}

function refusal(code: RepoAgentTemplateRefusalCode, message: string): RepoAgentTemplateRefusal {
    return { status: 'refused', code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** True when a catalog field carries text once HTML and whitespace are gone. */
function isNonEmptyCatalogText(value: unknown): boolean {
    return capTemplateText(value, 1).length > 0;
}

/**
 * Refuse any key the contract does not declare, and any missing required key.
 *
 * Plan §7.1: "an unknown or missing key refuses the instantiation rather than
 * guessing". This is what makes the manifest a CONTRACT instead of a hint —
 * a catalog that renames `soul` to `soulPath` is refused loudly here rather
 * than silently creating an Agent with no instructions.
 */
function assertExactKeys(
    source: Record<string, unknown>,
    requiredKeys: readonly string[],
    where: string,
): RepoAgentTemplateRefusal | null {
    const missing = requiredKeys.filter((key) => !(key in source));
    if (missing.length > 0) {
        return refusal(
            'manifest-key-missing',
            `${where} is missing required key(s): ${missing.join(', ')}.`,
        );
    }

    const unknown = Object.keys(source).filter((key) => !requiredKeys.includes(key));
    if (unknown.length > 0) {
        return refusal(
            'manifest-key-unknown',
            `${where} declares unknown key(s): ${unknown.join(', ')}.`,
        );
    }

    return null;
}

/** Case-insensitive membership in a list of allowed enum values. */
function isOneOf(values: readonly string[], value: unknown): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return values.some((candidate) => candidate === normalized);
}

function normalizeSkillList(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const slugs: string[] = [];
    for (const entry of value) {
        // The draft uses `{ slug, why }` rows; a bare string is the obvious
        // short form of the same statement, so both are accepted.
        const raw = isPlainObject(entry) ? entry.slug : entry;
        if (typeof raw !== 'string' || !SAFE_CATALOG_SLUG_RE.test(raw)) {
            return null;
        }
        if (!slugs.includes(raw)) {
            slugs.push(raw);
        }
    }

    return slugs;
}

/**
 * Parse + validate `skills.yml`.
 *
 * Loose on SHAPE (the plan pins no key set for this file) and strict on the
 * one thing that matters: `required` must name at least one well-formed
 * Skill slug. Plan §7.2's drift guard refuses to dispatch a provisioning run
 * without the `provision-app` Skill, so a template whose skills file is
 * empty is not instantiable.
 */
export function parseRepoAgentSkills(yamlText: string): RepoAgentTemplateSkillsParseResult {
    let raw: unknown;
    try {
        raw = YAML.parse(yamlText);
    } catch (error) {
        return refusal(
            'skills-invalid',
            `skills.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (!isPlainObject(raw)) {
        return refusal('skills-invalid', 'skills.yml must be a YAML mapping.');
    }

    const required = normalizeSkillList(raw.required);
    if (!required || required.length === 0) {
        return refusal(
            'skills-invalid',
            'skills.yml must declare a non-empty `required` list of Skill slugs.',
        );
    }
    if (required.length > REPO_AGENT_TEMPLATE_LIMITS.requiredSkills) {
        return refusal('skills-invalid', 'skills.yml declares too many required Skills.');
    }

    const recommended = raw.recommended === undefined ? [] : normalizeSkillList(raw.recommended);
    if (!recommended) {
        return refusal('skills-invalid', 'skills.yml `recommended` must be a list of Skill slugs.');
    }

    return { status: 'ok', skills: { required, recommended } };
}

/**
 * Parse + validate `.works/agent.yml` against the manifest contract.
 *
 * `expectedSlug` is checked against the manifest's own `slug` (and against
 * the allow-list): the file is fetched BY slug, so a manifest that describes
 * a different Agent than the one requested is refused rather than trusted.
 */
export function parseRepoAgentManifest(
    yamlText: string,
    expectedSlug: string,
): { status: 'ok'; values: Record<string, unknown> } | RepoAgentTemplateRefusal {
    if (!isInstantiableRepoAgentTemplateSlug(expectedSlug)) {
        return refusal(
            'slug-not-instantiable',
            `Agent template "${expectedSlug}" is not in REPO_TEMPLATE_INSTANTIABLE_SLUGS.`,
        );
    }

    let raw: unknown;
    try {
        raw = YAML.parse(yamlText);
    } catch (error) {
        return refusal(
            'manifest-yaml',
            `agent.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (!isPlainObject(raw)) {
        return refusal('manifest-invalid', 'agent.yml must be a YAML mapping.');
    }

    const keyProblem = assertExactKeys(raw, REPO_AGENT_TEMPLATE_REQUIRED_KEYS, 'agent.yml');
    if (keyProblem) {
        return keyProblem;
    }

    if (!isPlainObject(raw.kb)) {
        return refusal('manifest-invalid', 'agent.yml `kb` must be a mapping.');
    }
    if (!isPlainObject(raw.prompts)) {
        return refusal('manifest-invalid', 'agent.yml `prompts` must be a mapping.');
    }

    const keyProblemNested =
        assertExactKeys(raw.kb, REPO_AGENT_TEMPLATE_REQUIRED_KB_KEYS, 'agent.yml `kb`') ??
        assertExactKeys(
            raw.prompts,
            REPO_AGENT_TEMPLATE_REQUIRED_PROMPT_KEYS,
            'agent.yml `prompts`',
        );
    if (keyProblemNested) {
        return keyProblemNested;
    }

    if (raw.schemaVersion !== REPO_AGENT_MANIFEST_SCHEMA_VERSION) {
        return refusal(
            'manifest-invalid',
            `agent.yml schemaVersion must be ${REPO_AGENT_MANIFEST_SCHEMA_VERSION}.`,
        );
    }

    if (raw.slug !== expectedSlug || !SAFE_CATALOG_SLUG_RE.test(String(raw.slug))) {
        return refusal(
            'manifest-invalid',
            `agent.yml must describe the requested slug "${expectedSlug}".`,
        );
    }

    for (const key of ['name', 'title', 'summary', 'capabilities'] as const) {
        if (!isNonEmptyCatalogText(raw[key])) {
            return refusal('manifest-invalid', `agent.yml \`${key}\` must be a non-empty string.`);
        }
    }

    if (!(REPO_AGENT_TEMPLATE_SCOPES as readonly unknown[]).includes(raw.scope)) {
        return refusal(
            'manifest-invalid',
            `agent.yml \`scope\` must be one of: ${REPO_AGENT_TEMPLATE_SCOPES.join(', ')}.`,
        );
    }

    if (!isOneOf([AgentAvatarMode.ICON, AgentAvatarMode.IMAGE], raw.avatarMode)) {
        return refusal('manifest-invalid', 'agent.yml `avatarMode` must be ICON or IMAGE.');
    }

    if (!isNonEmptyCatalogText(raw.avatarIcon)) {
        return refusal('manifest-invalid', 'agent.yml `avatarIcon` must be a non-empty string.');
    }

    if (!isOneOf(Object.values(AgentIdleBehavior), raw.idleBehavior)) {
        return refusal(
            'manifest-invalid',
            'agent.yml `idleBehavior` must be a known idle behaviour.',
        );
    }

    // `heartbeatCadence` is an IntegerOrNull in the catalog schema: a number
    // of seconds, or an explicit `null` for "no heartbeat".
    if (raw.heartbeatCadence !== null) {
        const cadence = raw.heartbeatCadence;
        if (typeof cadence !== 'number' || !Number.isInteger(cadence) || cadence < 0) {
            return refusal(
                'manifest-invalid',
                'agent.yml `heartbeatCadence` must be an integer or null.',
            );
        }
    }

    // Permissions: EVERY declared flag must be boolean, and the object must
    // not be empty. The VALUES are never applied — see the note in
    // `createFromRepoTemplate` — but a manifest that declares a non-boolean
    // permission is a manifest this reader does not understand.
    if (!isPlainObject(raw.permissions) || Object.keys(raw.permissions).length === 0) {
        return refusal('manifest-invalid', 'agent.yml `permissions` must be a non-empty mapping.');
    }
    if (Object.values(raw.permissions).some((value) => typeof value !== 'boolean')) {
        return refusal('manifest-invalid', 'agent.yml `permissions` values must all be booleans.');
    }

    const suggestedSkills = normalizeSkillList(raw.suggestedSkills);
    if (!suggestedSkills || suggestedSkills.length > REPO_AGENT_TEMPLATE_LIMITS.suggestedSkills) {
        return refusal(
            'manifest-invalid',
            'agent.yml `suggestedSkills` must be a list of Skill slugs.',
        );
    }

    const tags = normalizeSkillList(raw.tags);
    if (!tags || tags.length > REPO_AGENT_TEMPLATE_LIMITS.tags) {
        return refusal('manifest-invalid', 'agent.yml `tags` must be a list of short tags.');
    }

    const kb = raw.kb;
    const seedPaths = kb.seedPaths;
    if (!Array.isArray(seedPaths)) {
        return refusal(
            'manifest-invalid',
            'agent.yml `kb.seedPaths` must be a list of directories.',
        );
    }
    if (seedPaths.length > REPO_AGENT_TEMPLATE_LIMITS.seedPaths) {
        return refusal('manifest-invalid', 'agent.yml `kb.seedPaths` declares too many entries.');
    }
    if (!seedPaths.every((entry) => typeof entry === 'string' && isSafeTemplatePath(entry))) {
        return refusal(
            'manifest-path-unsafe',
            'agent.yml `kb.seedPaths` entries must stay inside the template.',
        );
    }

    if (!isNonEmptyCatalogText(kb.citationPolicy)) {
        return refusal(
            'manifest-invalid',
            'agent.yml `kb.citationPolicy` must be a non-empty string.',
        );
    }

    const prompts = raw.prompts;
    if (typeof prompts.system !== 'string' || !isSafeTemplatePath(prompts.system)) {
        return refusal(
            'manifest-path-unsafe',
            'agent.yml `prompts.system` must stay inside the template.',
        );
    }

    const tasks = prompts.tasks;
    if (!Array.isArray(tasks)) {
        return refusal('manifest-invalid', 'agent.yml `prompts.tasks` must be a list.');
    }
    if (tasks.length > REPO_AGENT_TEMPLATE_LIMITS.tasks) {
        return refusal('manifest-invalid', 'agent.yml `prompts.tasks` declares too many entries.');
    }
    for (const task of tasks) {
        if (!isPlainObject(task)) {
            return refusal(
                'manifest-invalid',
                'agent.yml `prompts.tasks` entries must be mappings.',
            );
        }
        const taskProblem = assertExactKeys(
            task,
            REPO_AGENT_TEMPLATE_REQUIRED_TASK_KEYS,
            'agent.yml `prompts.tasks[]`',
        );
        if (taskProblem) {
            return taskProblem;
        }
        if (!isNonEmptyCatalogText(task.id) || !isNonEmptyCatalogText(task.title)) {
            return refusal(
                'manifest-invalid',
                'agent.yml `prompts.tasks[]` needs a non-empty id and title.',
            );
        }
        if (typeof task.path !== 'string' || !isSafeTemplatePath(task.path)) {
            return refusal(
                'manifest-path-unsafe',
                'agent.yml `prompts.tasks[].path` must stay inside the template.',
            );
        }
    }

    // Every path in the manifest is confined to the template directory —
    // including `soul`, which is the file this reader writes as SOUL.md.
    if (typeof raw.soul !== 'string' || !isSafeTemplatePath(raw.soul)) {
        return refusal('manifest-path-unsafe', 'agent.yml `soul` must stay inside the template.');
    }

    return { status: 'ok', values: raw };
}

/** `templates/<slug>/<relativePath>` — the only paths this reader ever reads. */
export function repoTemplatePath(slug: string, relativePath: string): string {
    return `templates/${slug}/${relativePath}`;
}

/**
 * Read one catalog file: authenticated first (App installation, else env
 * token), then — when that yields nothing — the tokenless raw read. Exactly
 * the order `agent-template-catalog.service.ts:188-206` uses, for the same
 * reason: the repository is public, so a missing token degrades to a slow
 * path, never to an empty catalog.
 */
async function readCatalogFile(
    source: RepoAgentTemplateSource,
    request: RepoAgentTemplateFileRequest,
): Promise<string | null> {
    const authenticated = await source.readAuthenticated(request);
    if (authenticated) {
        return authenticated;
    }

    return source.readPublicRaw(request);
}

/**
 * The production source: App-installation read through the git facade, and a
 * tokenless raw read with a fail-closed deadline.
 *
 * The raw read deliberately builds its URL from the same literal the API-side
 * catalog helper uses (`apps/api/src/organizations/org-template-catalog.service.ts:89-108`)
 * rather than through `GitFacadeService.getRawFileUrl`, which needs a synced
 * git-provider plugin and therefore throws in a partially wired deployment —
 * this path must work whenever the repository is public at all. The API-side
 * helper is not importable from this package (it lives in `apps/api`), so the
 * three guards it applies are mirrored here: a validated ref, a `..`-free
 * path, and a 10 s `AbortSignal` deadline.
 */
export function createRepoAgentTemplateSource(git?: GitFacadeService): RepoAgentTemplateSource {
    return {
        async readAuthenticated(request) {
            if (!git) {
                return null;
            }

            try {
                const token = await resolveCatalogReadToken(git);
                if (!token) {
                    return null;
                }

                const file = await git.getFileContent(
                    request.owner,
                    request.repo,
                    request.path,
                    { token, providerId: 'github' },
                    request.ref,
                );
                return file?.content ?? null;
            } catch {
                // A failed authenticated read is not a failure of the read:
                // fall through to the tokenless path below.
                return null;
            }
        },

        async readPublicRaw(request) {
            if (!SAFE_CATALOG_REF_RE.test(request.ref) || request.path.includes('..')) {
                return null;
            }

            const url = `${RAW_CATALOG_BASE}/${request.owner}/${request.repo}/${request.ref}/${request.path}`;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'Ever Works' },
                    signal: AbortSignal.timeout(RAW_READ_TIMEOUT_MS),
                });
                if (!response.ok) {
                    return null;
                }
                return await response.text();
            } catch {
                return null;
            }
        },
    };
}

/**
 * Resolve a token that can read `ever-works/agents`. Priority order matches
 * `agent-template-catalog.service.ts:166-172`: the platform GitHub App's
 * installation on the org (no extra secret), then an explicit env override.
 */
async function resolveCatalogReadToken(git: GitFacadeService): Promise<string | null> {
    const appToken = await git.getInstallationTokenForOwner(AGENTS_CATALOG_OWNER).catch(() => null);
    if (appToken) {
        return appToken;
    }

    return process.env.EVER_WORKS_AGENTS_TOKEN || process.env.GITHUB_TOKEN || null;
}

/**
 * Reads a repo-backed Agent template into the data an instantiation needs.
 *
 * Every file is read at `ref` (default `EVER_WORKS_AGENTS_REF`, else `main`),
 * and a mutable ref logs the same supply-chain warning the catalog service
 * logs (`agent-template-catalog.service.ts:138-148`).
 */
export class RepoAgentTemplateReader {
    private warnedMutableRef = false;

    constructor(
        private readonly source: RepoAgentTemplateSource = createRepoAgentTemplateSource(),
        private readonly logger: Logger = new Logger(RepoAgentTemplateReader.name),
    ) {}

    async read(
        slug: string,
        ref: string = resolveAgentsCatalogRef(),
    ): Promise<RepoAgentTemplateReadResult> {
        if (!isInstantiableRepoAgentTemplateSlug(slug)) {
            return refusal(
                'slug-not-instantiable',
                `Agent template "${slug}" is not in REPO_TEMPLATE_INSTANTIABLE_SLUGS.`,
            );
        }

        if (!isPinnedCatalogRef(ref) && !this.warnedMutableRef) {
            this.warnedMutableRef = true;
            this.logger.warn(
                `EVER_WORKS_AGENTS_REF is set to a mutable ref '${ref}'. Pin it to a commit SHA ` +
                    '(40 hex chars) or a version tag (vX.Y.Z) so a template cannot be substituted ' +
                    'between reads.',
            );
        }

        const manifestYaml = await readCatalogFile(this.source, {
            owner: AGENTS_CATALOG_OWNER,
            repo: AGENTS_CATALOG_REPO,
            ref,
            path: repoTemplatePath(slug, REPO_AGENT_TEMPLATE_MANIFEST_PATH),
        });
        if (!manifestYaml) {
            return refusal(
                'template-not-found',
                `Agent template "${slug}" has no ${REPO_AGENT_TEMPLATE_MANIFEST_PATH} at ${ref}.`,
            );
        }

        const parsed = parseRepoAgentManifest(manifestYaml, slug);
        if (parsed.status !== 'ok') {
            return parsed;
        }
        const values = parsed.values;

        const soulPath = values.soul as string;
        const soulRaw = await readCatalogFile(this.source, {
            owner: AGENTS_CATALOG_OWNER,
            repo: AGENTS_CATALOG_REPO,
            ref,
            path: repoTemplatePath(slug, soulPath),
        });
        if (!soulRaw) {
            return refusal(
                'soul-unreadable',
                `Agent template "${slug}" declares \`soul: ${soulPath}\` but has no such file.`,
            );
        }

        const skillsYaml = await readCatalogFile(this.source, {
            owner: AGENTS_CATALOG_OWNER,
            repo: AGENTS_CATALOG_REPO,
            ref,
            path: repoTemplatePath(slug, REPO_AGENT_TEMPLATE_SKILLS_PATH),
        });
        if (!skillsYaml) {
            return refusal(
                'skills-unreadable',
                `Agent template "${slug}" has no ${REPO_AGENT_TEMPLATE_SKILLS_PATH}.`,
            );
        }

        const skills = parseRepoAgentSkills(skillsYaml);
        if (skills.status !== 'ok') {
            return skills;
        }

        const kb = values.kb as Record<string, unknown>;
        const prompts = values.prompts as Record<string, unknown>;
        const tasks = prompts.tasks as Record<string, unknown>[];

        return {
            status: 'ok',
            template: {
                slug,
                ref,
                name: capTemplateText(values.name, REPO_AGENT_TEMPLATE_CAPS.name),
                title: capTemplateText(values.title, REPO_AGENT_TEMPLATE_CAPS.title),
                summary: capTemplateText(values.summary, REPO_AGENT_TEMPLATE_CAPS.summary),
                capabilities: capTemplateText(
                    values.capabilities,
                    REPO_AGENT_TEMPLATE_CAPS.capabilities,
                ),
                scope: values.scope as RepoAgentTemplateScope,
                avatarMode: String(values.avatarMode).toUpperCase(),
                avatarIcon: capTemplateText(values.avatarIcon, REPO_AGENT_TEMPLATE_CAPS.icon),
                // Tags and Skill slugs already passed the slug allow-list in
                // the manifest parser (`normalizeSkillList`): kebab-case, <= 64
                // characters, no markup. Nothing further to strip or cap.
                tags: values.tags as string[],
                suggestedSkills: values.suggestedSkills as string[],
                requiredSkills: skills.skills.required,
                recommendedSkills: skills.skills.recommended,
                // The catalog's instruction file is untrusted text that ends up
                // in the Agent's system prompt: strip markup and cap it before
                // it can reach `AgentFileService.write`.
                soul: capTemplateText(soulRaw, REPO_AGENT_TEMPLATE_CAPS.soul),
                soulPath,
                systemPromptPath: prompts.system as string,
                taskPaths: tasks.map((task) => ({
                    id: capTemplateText(task.id, REPO_AGENT_TEMPLATE_CAPS.slug),
                    title: capTemplateText(task.title, REPO_AGENT_TEMPLATE_CAPS.title),
                    path: task.path as string,
                })),
                seedPaths: (kb.seedPaths as string[]).map((seedPath) => String(seedPath)),
                citationPolicy: capTemplateText(
                    kb.citationPolicy,
                    REPO_AGENT_TEMPLATE_CAPS.citationPolicy,
                ),
            },
        };
    }
}
