import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * App Works live-lane safety surface — interlocks, the run estate file, secret
 * redaction and spend accounting.
 *
 * APW-13 plan §8.5 (`docs/specs/features/app-works/APW-13-golden-paths/plan.md:616-627`)
 * fixes seven interlocks, enforced in `app-works-live.setup.ts` (owned by T33) and
 * re-checked by each destructive helper. They live here, one exported assertion per
 * interlock, so each is separately testable and so no spec has to re-implement one:
 *
 * | # | Interlock                                                        | Assertion                       |
 * | - | ---------------------------------------------------------------- | ------------------------------- |
 * | 1 | web and API origins ∈ `APW_E2E_ALLOWED_BASE_URLS`, deny-list first | {@link assertAllowedOrigins}    |
 * | 2 | kube context ∈ the two allow-listed contexts, tier read-only      | {@link assertKubeContext}       |
 * | 3 | every upstream PR proposal's base owner == `APW_E2E_UPSTREAM_ORG` | {@link assertUpstreamOwner}     |
 * | 4 | both spend budgets set and positive                               | {@link assertBudgets}           |
 * | 5 | `<e2e-user>` has no `push` on the stable test upstream            | {@link assertNoPushAccess}      |
 * | 6 | the estate token is never passed to the platform                  | {@link assertGitHubTokenVariable} |
 * | 7 | a test namespace name starts with `apw-e2e-`                      | {@link assertTestNamespace}     |
 *
 * A refusal **names what it refused and never a value** (ACC-NEG-16,
 * `ACCEPTANCE.md:709`) — which is why none of these messages interpolates the
 * origin, context, token or namespace it rejected.
 *
 * Everything is injectable: env is a parameter defaulting to `process.env`, and
 * the estate path is a parameter defaulting to
 * `apps/web/e2e/.auth/app-works-estate.json` (plan §3.2, `plan.md:174-177`).
 */

/** The env bag every function here reads. Defaults to `process.env`. */
export type InterlockEnv = Record<string, string | undefined>;

/** The App Works lane variable names this module reads, in one place. */
export const APW_E2E = {
    allowedBaseUrls: 'APW_E2E_ALLOWED_BASE_URLS',
    webOrigin: 'PLAYWRIGHT_BASE_URL',
    apiOrigin: 'API_URL',
    userClusterContext: 'APW_E2E_USER_CLUSTER_CONTEXT',
    appsTierContext: 'APW_E2E_APPS_TIER_CONTEXT',
    appsTierReadKubeconfig: 'APW_E2E_APPS_TIER_READ_KUBECONFIG',
    upstreamOrg: 'APW_E2E_UPSTREAM_ORG',
    forkOrg: 'APW_E2E_FORK_ORG',
    githubUser: 'APW_E2E_GITHUB_USER',
    tokenBudget: 'APW_E2E_TOKEN_BUDGET',
    actionsMinutesBudget: 'APW_E2E_ACTIONS_MINUTES_BUDGET',
    githubUserToken: 'APW_E2E_GITHUB_USER_TOKEN',
    githubEstateToken: 'APW_E2E_GITHUB_ESTATE_TOKEN',
    honeyToken: 'APW_E2E_HONEYTOKEN',
    runId: 'APW_E2E_RUN_ID',
    lane: 'APW_E2E_LANE',
    estatePath: 'APW_E2E_ESTATE_PATH',
} as const;

/** The seven interlocks of plan §8.5, as data so nothing can quietly drop one. */
export interface Interlock {
    /** §8.5 numbering, 1-based. */
    readonly id: number;
    /** What it refuses. */
    readonly name: string;
    /** The exported assertion that enforces it. */
    readonly assertion: string;
}

/** The seven interlocks of plan §8.5 (`plan.md:616-627`). */
export const APW_INTERLOCKS: readonly Interlock[] = [
    {
        id: 1,
        name: 'web and API origins are allow-listed, and the allow-list holds no production origin',
        assertion: 'assertAllowedOrigins',
    },
    {
        id: 2,
        name: 'kube context is one of the two allow-listed contexts; apps-tier credentials are read-only',
        assertion: 'assertKubeContext',
    },
    {
        id: 3,
        name: "every upstream PR proposal's base owner is APW_E2E_UPSTREAM_ORG",
        assertion: 'assertUpstreamOwner',
    },
    {
        id: 4,
        name: 'APW_E2E_TOKEN_BUDGET and APW_E2E_ACTIONS_MINUTES_BUDGET are set and positive',
        assertion: 'assertBudgets',
    },
    {
        id: 5,
        name: '<e2e-user> has no push permission on the stable test upstream',
        assertion: 'assertNoPushAccess',
    },
    {
        id: 6,
        name: 'APW_E2E_GITHUB_ESTATE_TOKEN is never passed to the platform',
        assertion: 'assertGitHubTokenVariable',
    },
    {
        id: 7,
        name: 'a test namespace name starts with apw-e2e-',
        assertion: 'assertTestNamespace',
    },
];

/** The prefix every test namespace must carry (interlock 7). */
export const TEST_NAMESPACE_PREFIX = 'apw-e2e-';

/**
 * **Hard-coded production origin deny-list** (plan §8.5 interlock 1, the "second
 * check"). These hosts are refused even when a misconfigured
 * `APW_E2E_ALLOWED_BASE_URLS` lists them — the point of a deny-list is that it
 * does not consult the allow-list.
 *
 * Matching is by **exact hostname**, so a per-App subdomain of the platform's own
 * domain (`<slug>.ever.works`, R-16) stays usable while the apex and the
 * platform's own app/api hosts — the production addresses — are refused.
 */
export const PRODUCTION_ORIGINS: readonly string[] = [
    'ever.works',
    'app.ever.works',
    'api.ever.works',
    'www.ever.works',
    'ever.co',
    'app.ever.co',
    'api.ever.co',
    'www.ever.co',
    'gauzy.co',
    'app.gauzy.co',
    'api.gauzy.co',
    'ever.team',
    'app.ever.team',
    'api.ever.team',
];

/** `true` when `origin`'s hostname is a hard-coded production origin. */
export function isProductionOrigin(origin: string | undefined): boolean {
    if (!origin || origin.trim() === '') return false;
    let hostname: string;
    try {
        hostname = new URL(origin.trim()).hostname.toLowerCase();
    } catch {
        return false;
    }
    return PRODUCTION_ORIGINS.includes(hostname);
}

/** Split a comma/whitespace separated list, dropping empties. */
function splitList(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Normalise an origin to `protocol//host[:port]` for comparison. */
function normaliseOrigin(origin: string): string | null {
    try {
        const url = new URL(origin.trim());
        return `${url.protocol}//${url.host.toLowerCase()}`;
    } catch {
        return null;
    }
}

/**
 * **Interlock 1.** The web and API origins must be in
 * `APW_E2E_ALLOWED_BASE_URLS`, and the allow-list itself — as well as either
 * origin — must not be a production origin.
 *
 * The deny-list is checked **first** and over the whole list: a production origin
 * inside a misconfigured allow-list is refused before membership is even
 * considered, so "it was in the list" can never be the reason a production lane
 * starts.
 */
export function assertAllowedOrigins(env: InterlockEnv = process.env): void {
    const allowed = splitList(env[APW_E2E.allowedBaseUrls]);
    if (allowed.length === 0) {
        throw new Error(
            `${APW_E2E.allowedBaseUrls} is not set — the lane refuses to start without an ` +
                'allow-list of dev and stage origins',
        );
    }

    // 1a. The deny-list wins, over the list itself.
    for (const entry of allowed) {
        if (isProductionOrigin(entry)) {
            throw new Error(
                `${APW_E2E.allowedBaseUrls} lists a production origin — refused by the ` +
                    'hard-coded deny-list (plan §8.5 interlock 1)',
            );
        }
        if (normaliseOrigin(entry) === null) {
            throw new Error(
                `${APW_E2E.allowedBaseUrls} contains an entry that is not an http(s) origin`,
            );
        }
    }

    // 1b. Every origin the lane will talk to must be allow-listed, and not production.
    const allowSet = new Set(allowed.map((entry) => normaliseOrigin(entry)));
    for (const variable of [APW_E2E.webOrigin, APW_E2E.apiOrigin]) {
        const origin = env[variable];
        if (!origin || origin.trim() === '') {
            throw new Error(`${variable} is not set — the lane has no origin to point at`);
        }
        if (isProductionOrigin(origin)) {
            throw new Error(
                `${variable} points at a production origin — refused by the hard-coded ` +
                    'deny-list (plan §8.5 interlock 1)',
            );
        }
        const normalised = normaliseOrigin(origin);
        if (normalised === null) {
            throw new Error(`${variable} is not an http(s) origin`);
        }
        if (!allowSet.has(normalised)) {
            throw new Error(
                `${variable} is not in ${APW_E2E.allowedBaseUrls} — the lane refuses to start ` +
                    '(plan §8.5 interlock 1)',
            );
        }
    }
}

/** What {@link assertKubeContext} needs to know about the cluster in use. */
export interface KubeContextInput {
    /** The context the lane is about to use. */
    context?: string;
    /** The kubeconfig that context came from. */
    kubeconfigPath?: string;
}

/**
 * **Interlock 2.** The kube context must be one of
 * `{APW_E2E_USER_CLUSTER_CONTEXT, APW_E2E_APPS_TIER_CONTEXT}`, and **apps-tier
 * credentials are read-only**: the apps-tier context may only be used with
 * `APW_E2E_APPS_TIER_READ_KUBECONFIG`, never with a writable kubeconfig.
 */
export function assertKubeContext(
    input: KubeContextInput = {},
    env: InterlockEnv = process.env,
): void {
    const userContext = env[APW_E2E.userClusterContext];
    const appsTierContext = env[APW_E2E.appsTierContext];
    if (!userContext && !appsTierContext) {
        throw new Error(
            `neither ${APW_E2E.userClusterContext} nor ${APW_E2E.appsTierContext} is set — ` +
                'there is no allow-listed kube context (plan §8.5 interlock 2)',
        );
    }
    const context = input.context;
    if (!context) {
        throw new Error('no kube context was given — the lane refuses to start (interlock 2)');
    }

    if (appsTierContext && context === appsTierContext) {
        const readKubeconfig = env[APW_E2E.appsTierReadKubeconfig];
        if (!readKubeconfig) {
            throw new Error(
                `${APW_E2E.appsTierContext} is set but ${APW_E2E.appsTierReadKubeconfig} is not ` +
                    '— apps-tier credentials are read-only (plan §8.5 interlock 2)',
            );
        }
        if (input.kubeconfigPath !== readKubeconfig) {
            throw new Error(
                `${APW_E2E.appsTierContext} may only be used with the read-only ` +
                    `${APW_E2E.appsTierReadKubeconfig} (plan §8.5 interlock 2)`,
            );
        }
        return;
    }

    if (userContext && context === userContext) return;

    throw new Error(
        'kube context is not one of the allow-listed contexts ' +
            `(${APW_E2E.userClusterContext}, ${APW_E2E.appsTierContext}) — the lane refuses to ` +
            'start (plan §8.5 interlock 2)',
    );
}

/**
 * **Interlock 3.** Every upstream PR proposal's base owner must be
 * `APW_E2E_UPSTREAM_ORG`; a proposal aimed anywhere else is refused, so the lane
 * can never open a pull request against a real third-party repository.
 */
export function assertUpstreamOwner(
    owner: string | undefined,
    env: InterlockEnv = process.env,
): void {
    const expected = env[APW_E2E.upstreamOrg];
    if (!expected || expected.trim() === '') {
        throw new Error(
            `${APW_E2E.upstreamOrg} is not set — the lane has no test upstream to allow ` +
                '(plan §8.5 interlock 3)',
        );
    }
    if (!owner || owner.trim() === '') {
        throw new Error('the upstream owner is missing — the lane refuses to start (interlock 3)');
    }
    if (owner.trim().toLowerCase() !== expected.trim().toLowerCase()) {
        throw new Error(
            `an upstream owner outside ${APW_E2E.upstreamOrg} was proposed — refused ` +
                '(plan §8.5 interlock 3)',
        );
    }
}

/**
 * **Interlock 3**, the proposal half: the base owner of an upstream PR proposal.
 * Separate from {@link assertUpstreamOwner} because ACC-NEG-16 names it
 * explicitly ("including a proposal whose base owner is outside it").
 */
export function assertProposalBaseOwner(
    baseOwner: string | undefined,
    env: InterlockEnv = process.env,
): void {
    try {
        assertUpstreamOwner(baseOwner, env);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.replace('an upstream owner', 'an upstream PR proposal base owner'));
    }
}

/** The two hard spend caps of a run. */
export interface Budgets {
    /** `APW_E2E_TOKEN_BUDGET` — model tokens. */
    tokens: number;
    /** `APW_E2E_ACTIONS_MINUTES_BUDGET` — runner minutes. */
    actionsMinutes: number;
}

/** Read one budget, refusing an unset, non-numeric or non-positive value. */
function positiveBudget(raw: string | undefined, variable: string): number {
    if (raw === undefined || raw.trim() === '') {
        throw new Error(
            `${variable} is not set — the lane refuses to start without a positive spend ` +
                'budget (plan §8.5 interlock 4)',
        );
    }
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
            `${variable} is not a positive number — the lane refuses to start ` +
                '(plan §8.5 interlock 4)',
        );
    }
    return value;
}

/**
 * **Interlock 4.** Both spend caps must be set and positive, or the lane never
 * starts (S9/S10: a lane with no budget cannot fail *with reason `budget`*).
 */
export function assertBudgets(env: InterlockEnv = process.env): Budgets {
    return {
        tokens: positiveBudget(env[APW_E2E.tokenBudget], APW_E2E.tokenBudget),
        actionsMinutes: positiveBudget(
            env[APW_E2E.actionsMinutesBudget],
            APW_E2E.actionsMinutesBudget,
        ),
    };
}

/** GitHub's `permissions` object, as `GET /repos/:o/:r` returns it. */
export interface GitHubPermissions {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
}

/**
 * **Interlock 5.** `<e2e-user>` must have **no `push` permission** on the stable
 * test upstream — otherwise the fork/link scenarios could write to the upstream
 * instead of the run's own copy.
 */
export function assertNoPushAccess(permissions: GitHubPermissions | undefined): void {
    if (!permissions) {
        throw new Error(
            'the upstream repository permissions were not read — interlock 5 cannot pass ' +
                'without them (plan §8.5)',
        );
    }
    if (permissions.admin === true || permissions.maintain === true || permissions.push === true) {
        throw new Error(
            `<${APW_E2E.githubUser}> has write access to the stable test upstream — the lane ` +
                'refuses to start (plan §8.5 interlock 5)',
        );
    }
}

/** The only GitHub token variable the platform may ever be given. */
export const PLATFORM_GITHUB_TOKEN_VARIABLE = APW_E2E.githubUserToken;

/** The harness-only estate token, which never reaches the platform. */
export const HARNESS_ONLY_GITHUB_TOKEN_VARIABLE = APW_E2E.githubEstateToken;

/**
 * **Interlock 6.** The helper that attaches a GitHub token to the platform
 * accepts **only** `APW_E2E_GITHUB_USER_TOKEN`. Every other variable name — the
 * estate token above all — is refused, so "the harness's own credential" can
 * never be handed to the product it is testing.
 */
export function assertGitHubTokenVariable(variable: string): void {
    if (variable === HARNESS_ONLY_GITHUB_TOKEN_VARIABLE) {
        throw new Error(
            `${HARNESS_ONLY_GITHUB_TOKEN_VARIABLE} is harness-only and is never passed to the ` +
                'platform (plan §8.5 interlock 6)',
        );
    }
    if (variable !== PLATFORM_GITHUB_TOKEN_VARIABLE) {
        throw new Error(
            `only ${PLATFORM_GITHUB_TOKEN_VARIABLE} may be attached to the platform as a ` +
                'GitHub token (plan §8.5 interlock 6)',
        );
    }
}

/**
 * The token a platform-facing call may use: interlock 6's assertion plus the
 * value read from {@link PLATFORM_GITHUB_TOKEN_VARIABLE} only.
 *
 * A lane whose user token happens to equal the estate token is refused as well —
 * the same credential must not serve both roles.
 */
export function platformGitHubToken(
    env: InterlockEnv = process.env,
    variable: string = PLATFORM_GITHUB_TOKEN_VARIABLE,
): string {
    assertGitHubTokenVariable(variable);
    const value = env[variable];
    if (!value || value.trim() === '') {
        throw new Error(
            `${PLATFORM_GITHUB_TOKEN_VARIABLE} is not set — the lane cannot attach a GitHub ` +
                'connection',
        );
    }
    const estate = env[HARNESS_ONLY_GITHUB_TOKEN_VARIABLE];
    if (estate && value === estate) {
        throw new Error(
            'the value offered to the platform is the harness estate credential — refused ' +
                '(plan §8.5 interlock 6)',
        );
    }
    return value;
}

/**
 * **Interlock 7.** A test namespace name must start with `apw-e2e-`: the prefix is
 * what makes a namespace recognisably ephemeral, so a cleanup step can never be
 * pointed at a real one.
 */
export function assertTestNamespace(name: string | undefined): void {
    if (!name || name.trim() === '') {
        throw new Error('a test namespace name is required (plan §8.5 interlock 7)');
    }
    if (!name.startsWith(TEST_NAMESPACE_PREFIX)) {
        throw new Error(
            `a test namespace name must start with ${TEST_NAMESPACE_PREFIX} — refused ` +
                '(plan §8.5 interlock 7)',
        );
    }
}

/** Everything {@link assertLaneMayStart} can check before a lane runs. */
export interface StartInterlockInput {
    kube?: KubeContextInput;
    /** The stable test upstream's owner, when known. */
    upstreamOwner?: string;
    /** The base owner of the first upstream PR proposal, when known. */
    proposalBaseOwner?: string;
    /** `<e2e-user>`'s permissions on the stable test upstream, when read. */
    upstreamPermissions?: GitHubPermissions;
    /** The variable a caller is about to attach to the platform. */
    requestedGitHubTokenVariable?: string;
    /** Namespaces the run will use or clean up. */
    namespaces?: readonly string[];
}

/**
 * Run the seven interlocks of plan §8.5 in order, for
 * `app-works-live.setup.ts` (T33). The checks whose inputs are not known before
 * the lane starts are skipped only when their input is absent — never silently
 * passed — and the four that need no input always run.
 */
export function assertLaneMayStart(
    input: StartInterlockInput = {},
    env: InterlockEnv = process.env,
): void {
    assertAllowedOrigins(env); // 1
    assertKubeContext(input.kube ?? {}, env); // 2
    if (input.proposalBaseOwner !== undefined)
        assertProposalBaseOwner(input.proposalBaseOwner, env);
    if (input.upstreamOwner !== undefined) assertUpstreamOwner(input.upstreamOwner, env);
    assertBudgets(env); // 4
    if (input.upstreamPermissions !== undefined) assertNoPushAccess(input.upstreamPermissions); // 5
    if (input.requestedGitHubTokenVariable !== undefined) {
        assertGitHubTokenVariable(input.requestedGitHubTokenVariable); // 6
    }
    for (const namespace of input.namespaces ?? []) assertTestNamespace(namespace); // 7
}

// ---------------------------------------------------------------------------
// Run id, markers and the estate file (plan §3.2)
// ---------------------------------------------------------------------------

/** The estate file's path, relative to `apps/web` (plan §3.2). */
export const ESTATE_RELATIVE_PATH = 'e2e/.auth/app-works-estate.json';

/**
 * Resolve a path relative to `apps/web`, walking up from the cwd so the helper
 * works whether vitest/Playwright run from `apps/web` or from the repo root.
 */
function resolveFromWebAppRoot(relative: string): string {
    let dir = process.cwd();
    for (;;) {
        for (const candidate of [dir, resolve(dir, 'apps/web')]) {
            if (existsSync(resolve(candidate, 'e2e'))) return resolve(candidate, relative);
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(process.cwd(), relative);
}

/**
 * Where the estate file lives: `apps/web/e2e/.auth/app-works-estate.json`
 * (plan §3.2) unless `APW_E2E_ESTATE_PATH` overrides it (the unit spec's temp dir).
 */
export function defaultEstatePath(env: InterlockEnv = process.env): string {
    const override = env[APW_E2E.estatePath];
    if (override && override.trim() !== '') return resolve(override.trim());
    return resolveFromWebAppRoot(ESTATE_RELATIVE_PATH);
}

/**
 * The live-run estate file (plan §3.2, `plan.md:174-177`): run id, generated
 * repository names, App Work ids, namespace names, PR numbers — the cleanup
 * step's input and the summary's source.
 */
export interface AppWorksEstate {
    runId: string;
    /** Generated repository names, `owner/name`. */
    repositories: string[];
    /** App Work ids. */
    appWorkIds: string[];
    /** Namespace names; each must pass interlock 7 before it is written. */
    namespaces: string[];
    /** Pull-request numbers the run opened. */
    pullRequestNumbers: number[];
    /** The lane the run belongs to, when known. */
    lane?: string;
    /** ISO timestamps. */
    startedAt?: string;
    updatedAt?: string;
    /** Additive fields a later task records (e.g. the Agent id of T64). */
    [key: string]: unknown;
}

/** Options shared by the estate readers and writers. */
export interface EstateOptions {
    /** Overrides {@link defaultEstatePath}. */
    path?: string;
    /** The env bag the default path is derived from. */
    env?: InterlockEnv;
}

/** Shallow-slug a marker scope so it survives a URL and a fixture env name. */
function slug(value: string): string {
    return (
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'marker'
    );
}

/**
 * The run id every run-unique name and marker is seeded from
 * (`ACCEPTANCE.md:121`). Refused when unset: a lane without a run id would write
 * names it cannot clean up.
 */
export function runId(env: InterlockEnv = process.env): string {
    const raw = env[APW_E2E.runId];
    if (!raw || raw.trim() === '') {
        throw new Error(
            `${APW_E2E.runId} is not set — every run-unique name and marker is seeded from it ` +
                '(ACCEPTANCE §0.4)',
        );
    }
    return raw.trim();
}

/**
 * A run-unique marker: `<run id>-<scope>`. The lane types it into the prompted
 * env entry, the fixture serves it back at `/marker`, and ACC-13-02 asserts both
 * halves — so it must be unique per run and stable within one.
 */
export function runMarker(scope = 'marker', env: InterlockEnv = process.env): string {
    return `${runId(env)}-${slug(scope)}`;
}

/**
 * A run-unique test namespace name. Built on {@link TEST_NAMESPACE_PREFIX} so
 * interlock 7 holds by construction.
 */
export function testNamespaceName(scope: string, env: InterlockEnv = process.env): string {
    const name = `${TEST_NAMESPACE_PREFIX}${runId(env)}-${slug(scope)}`;
    assertTestNamespace(name);
    return name;
}

/** An empty estate for a run. */
export function emptyEstate(
    id: string = runId(),
    lane?: string,
    at: string = new Date().toISOString(),
): AppWorksEstate {
    return {
        runId: id,
        lane,
        startedAt: at,
        updatedAt: at,
        repositories: [],
        appWorkIds: [],
        namespaces: [],
        pullRequestNumbers: [],
    };
}

/** Whether the estate file exists. */
export function estateExists(options: EstateOptions = {}): boolean {
    return existsSync(options.path ?? defaultEstatePath(options.env ?? process.env));
}

/** Coerce a value to a string array, refusing anything else. */
function stringArray(value: unknown, field: string, path: string): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`the estate file at ${path} has a non-string ${field} list`);
    }
    return value as string[];
}

/** Coerce a value to a number array, refusing anything else. */
function numberArray(value: unknown, field: string, path: string): number[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) {
        throw new Error(`the estate file at ${path} has a non-number ${field} list`);
    }
    return value as number[];
}

/**
 * Read the estate file. Throws when it is missing or malformed — a cleanup step
 * with no estate file is a real failure, not an empty run.
 */
export function readEstate(options: EstateOptions = {}): AppWorksEstate {
    const path = options.path ?? defaultEstatePath(options.env ?? process.env);
    if (!existsSync(path)) {
        throw new Error(`no App Works estate file at ${path} — there is nothing to clean up`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(
            `the estate file at ${path} is not valid JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`the estate file at ${path} is not an estate object`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.runId !== 'string' || record.runId === '') {
        throw new Error(`the estate file at ${path} has no run id`);
    }
    return {
        ...record,
        runId: record.runId,
        repositories: stringArray(record.repositories ?? [], 'repositories', path),
        appWorkIds: stringArray(record.appWorkIds ?? [], 'appWorkIds', path),
        namespaces: stringArray(record.namespaces ?? [], 'namespaces', path),
        pullRequestNumbers: numberArray(
            record.pullRequestNumbers ?? [],
            'pullRequestNumbers',
            path,
        ),
    };
}

/**
 * Write the estate file, creating `.auth/` if needed, and return its path.
 *
 * Every namespace is re-checked against interlock 7 first: the estate file is
 * what the cleanup step reads, so a namespace that must never be deleted must
 * never get in.
 */
export function writeEstate(estate: AppWorksEstate, options: EstateOptions = {}): string {
    const path = options.path ?? defaultEstatePath(options.env ?? process.env);
    for (const namespace of estate.namespaces) assertTestNamespace(namespace);
    const payload: AppWorksEstate = {
        ...estate,
        updatedAt: new Date().toISOString(),
        repositories: [...estate.repositories],
        appWorkIds: [...estate.appWorkIds],
        namespaces: [...estate.namespaces],
        pullRequestNumbers: [...estate.pullRequestNumbers],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    return path;
}

/**
 * Merge a patch into the estate file read from disk and write it back — the
 * additive update every lane step uses, so two steps cannot clobber each other's
 * discoveries.
 */
export function updateEstate(
    patch: Partial<AppWorksEstate>,
    options: EstateOptions = {},
): AppWorksEstate {
    const current = readEstate(options);
    const merged: AppWorksEstate = {
        ...current,
        ...patch,
        repositories: unique([...current.repositories, ...(patch.repositories ?? [])]),
        appWorkIds: unique([...current.appWorkIds, ...(patch.appWorkIds ?? [])]),
        namespaces: unique([...current.namespaces, ...(patch.namespaces ?? [])]),
        pullRequestNumbers: unique([
            ...current.pullRequestNumbers,
            ...(patch.pullRequestNumbers ?? []),
        ]),
    };
    writeEstate(merged, options);
    return merged;
}

/** Deduplicate, keeping the first occurrence's order. */
function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Redaction (plan §8.7)
// ---------------------------------------------------------------------------

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Variable names whose **value** is a secret, beyond the `APW_E2E_*` shape rules
 * below. `APW_E2E_HONEYTOKEN` is credential-shaped by construction (plan §5.3) and
 * `EVER_ID_CLIENT_SECRET` is named a secret by ACCEPTANCE §0.4
 * (`ACCEPTANCE.md:143`) even though it does not carry the `APW_E2E_` prefix.
 */
export const KNOWN_SECRET_VARIABLES: readonly string[] = [
    APW_E2E.honeyToken,
    'EVER_ID_CLIENT_SECRET',
];

/**
 * Suffixes that make an `APW_E2E_*` variable a secret. Anchored, so
 * `APW_E2E_TOKEN_BUDGET` (a cap, not a credential) is not mistaken for a token.
 */
export const SECRET_VARIABLE_SUFFIXES: readonly RegExp[] = [
    /_TOKEN$/,
    /_KEY$/,
    /_SECRET$/,
    /_PASSWORD$/,
    /KUBECONFIG$/,
];

/**
 * The names of every secret-valued lane variable, in one place: every
 * `APW_E2E_*` variable whose name is credential-shaped, the honeytoken, and
 * {@link KNOWN_SECRET_VARIABLES}.
 */
export function secretVariableNames(env: InterlockEnv = process.env): string[] {
    const names = new Set<string>(KNOWN_SECRET_VARIABLES);
    for (const name of Object.keys(env)) {
        if (!name.startsWith('APW_E2E_')) continue;
        if (SECRET_VARIABLE_SUFFIXES.some((suffix) => suffix.test(name))) names.add(name);
    }
    return [...names].filter((name) => (env[name] ?? '').trim() !== '');
}

/** Every secret value a lane is holding, longest first so overlaps replace cleanly. */
export function secretValues(env: InterlockEnv = process.env): string[] {
    const values = secretVariableNames(env)
        .map((name) => env[name] as string)
        .filter((value) => value.trim() !== '');
    return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** `true` for a plain object — the only object shape `redact` traverses. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
}

/** Replace every secret occurrence inside one value, recursively. */
function redactValue(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === 'string') {
        let out = value;
        for (const secret of secrets) out = out.split(secret).join(REDACTED);
        return out;
    }
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) out[key] = redactValue(entry, secrets);
        return out;
    }
    return value;
}

/**
 * Redact every known lane secret and the honeytoken out of an artefact
 * (plan §8.7: "`app-works-live.ts` scans every attachment for every known secret
 * value and the honeytoken").
 *
 * Works on **nested JSON** and on **plain text** (a trace, a log tail, a
 * `kubectl` dump): strings are rewritten everywhere they appear, arrays and plain
 * objects are traversed, and anything else (Buffer, Date, class instance) is
 * returned untouched. The input is **not** mutated — the redacted copy is what a
 * caller attaches.
 */
export function redact<T>(artefact: T, env: InterlockEnv = process.env): T {
    return redactValue(artefact, secretValues(env)) as T;
}

/** Collect every string inside a value, for the leak scan. */
function collectStrings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') {
        out.push(value);
    } else if (Array.isArray(value)) {
        for (const entry of value) collectStrings(entry, out);
    } else if (isPlainObject(value)) {
        for (const entry of Object.values(value)) collectStrings(entry, out);
    }
    return out;
}

/**
 * The names of the secrets that appear in an artefact — **never their values**,
 * because this list is itself written into a failure message.
 */
export function findSecretLeaks(artefact: unknown, env: InterlockEnv = process.env): string[] {
    const texts = collectStrings(artefact);
    const leaks: string[] = [];
    for (const name of secretVariableNames(env)) {
        const value = env[name] as string;
        if (texts.some((text) => text.includes(value))) leaks.push(name);
    }
    return leaks;
}

/**
 * Fail the run when an artefact still holds a secret (plan §8.7: "a hit fails the
 * run and deletes that attachment locally"). The message names the variable, not
 * the value.
 */
export function assertNoSecretLeak(artefact: unknown, env: InterlockEnv = process.env): void {
    const leaks = findSecretLeaks(artefact, env);
    if (leaks.length > 0) {
        throw new Error(
            `an artefact contains ${leaks.join(', ')} — refused, and the attachment must be ` +
                'deleted locally (plan §8.7)',
        );
    }
}

// ---------------------------------------------------------------------------
// Spend accounting (plan §8.2, FR-59)
// ---------------------------------------------------------------------------

/**
 * A Run or Build receipt, as CONTRACTS §4 links it in Activity. APW-05's Build
 * receipt records the `checks` matrix's minutes in `checksBillableMinutes`,
 * counted inside `billableMinutes` (plan §9.6, `plan.md:765-769`).
 */
export interface RunReceipt {
    /** `run` counts model tokens; `build` counts runner minutes. */
    kind: 'run' | 'build';
    /** Actions minutes the receipt bills. */
    actionsMinutes?: number;
    /** Model tokens the Run spent. */
    tokens?: number;
    /** The checks matrix's billable minutes. */
    checksBillableMinutes?: number;
    /** Total billable minutes, checks included. */
    billableMinutes?: number;
    /** Where the receipt came from, for the summary. */
    url?: string;
    [key: string]: unknown;
}

/** What a run spent. */
export interface Spend {
    actionsMinutes: number;
    tokens: number;
}

/** A missing count is zero here; T66 tightens a missing token count into a failure. */
function numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One receipt's Actions minutes, never double-counting the checks matrix. */
function minutesOf(receipt: RunReceipt): number {
    if (typeof receipt.actionsMinutes === 'number') return receipt.actionsMinutes;
    const billable = numberOrZero(receipt.billableMinutes);
    const checks =
        receipt.billableMinutes === undefined ? numberOrZero(receipt.checksBillableMinutes) : 0;
    return billable + checks;
}

/**
 * Total `{ actionsMinutes, tokens }` over the Run and Build receipts of a run
 * (plan §8.2: "`accountSpend(receipts: RunReceipt[])` sums `{ actionsMinutes,
 * tokens }` over the Run and Build receipts"; FR-59, ACC-13-16).
 *
 * A receipt of another kind is refused rather than skipped: silently dropping one
 * would under-report spend against a hard cap.
 */
export function accountSpend(receipts: readonly RunReceipt[]): Spend {
    let actionsMinutes = 0;
    let tokens = 0;
    for (const receipt of receipts) {
        if (receipt.kind !== 'run' && receipt.kind !== 'build') {
            throw new Error(
                `accountSpend: a receipt of kind "${String(
                    receipt.kind,
                )}" is neither a Run nor a Build receipt (FR-59 counts those two)`,
            );
        }
        actionsMinutes += minutesOf(receipt);
        tokens += numberOrZero(receipt.tokens);
    }
    return { actionsMinutes, tokens };
}

/** Both budgets, read from the environment (interlock 4 included). */
export function budgetsFromEnv(env: InterlockEnv = process.env): Budgets {
    return assertBudgets(env);
}

/**
 * The error a run fails with when it exceeds a budget. `reason` is exactly
 * `budget` (ACC-13-16, S9: "the lane stops starting new steps, finishes cleanup,
 * and fails with reason **budget**").
 */
export class BudgetExceededError extends Error {
    readonly reason: 'budget' = 'budget';
    readonly spend: Spend;
    readonly budgets: Budgets;

    constructor(spend: Spend, budgets: Budgets) {
        super(
            `budget: spend ${spend.actionsMinutes} / ${budgets.actionsMinutes} Actions minutes · ` +
                `${spend.tokens} / ${budgets.tokens} tokens — reason: budget (ACC-13-16)`,
        );
        this.name = 'BudgetExceededError';
        this.spend = spend;
        this.budgets = budgets;
    }
}

/** The run-summary spend line the spec fixes (`spec.md:482-483`). */
export function formatSpendLine(spend: Spend, budgets: Budgets): string {
    return (
        `Spend: ${spend.actionsMinutes} / ${budgets.actionsMinutes} Actions minutes · ` +
        `${spend.tokens} / ${budgets.tokens} tokens`
    );
}

/**
 * Refuse a spend that has crossed either cap, with reason `budget`.
 *
 * @throws BudgetExceededError whose `reason` is exactly `budget`.
 */
export function assertWithinBudget(spend: Spend, budgets: Budgets): void {
    if (spend.tokens > budgets.tokens || spend.actionsMinutes > budgets.actionsMinutes) {
        throw new BudgetExceededError(spend, budgets);
    }
}
