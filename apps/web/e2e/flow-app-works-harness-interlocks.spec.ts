/**
 * APW-13 T33 — the harness's own safety interlocks (ACC-NEG-16, ACC-13-16, ACC-13-17).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-NEG-16 — "The suite's own safety interlocks"** (`ACCEPTANCE.md:721`):
 *
 * > The live harness refuses to start — naming what it refused and never a value — for a web
 * > or API origin not in `APW_E2E_ALLOWED_BASE_URLS` (a production origin even when listed),
 * > an unlisted kube context, an upstream owner outside `APW_E2E_UPSTREAM_ORG` (including a
 * > proposal whose base owner is outside it), an unset or non-positive spend budget, a
 * > missing required variable, or `<e2e-user>` having push access to the test upstream
 * > (APW-13 S10, S11, S18, FR-45); a static check fails if any spec or helper calls a
 * > repository-delete endpoint.
 *
 * **ACC-13-16** (`ACCEPTANCE.md:1418`):
 *
 * > A run over budget fails with reason **budget**; every run summary shows spend against
 * > budget
 *
 * **ACC-13-17** (`ACCEPTANCE.md:1419`):
 *
 * > No lane code path can delete a GitHub repository (static check); namespaces removed only
 * > in allow-listed contexts
 *
 * **ACC-13 cross-cutting** (`ACCEPTANCE.md:1428`) names this file for the same property: "a
 * live lane pointed at a production origin, unlisted context or non-test upstream refuses to
 * start".
 *
 * ## What this file is, and how it relates to the unit specs beside it
 *
 * ACCEPTANCE's rows name three layers for these criteria: T8–T11's **unit** specs
 * (`e2e/helpers/__tests__/*.unit.spec.ts`, run under vitest) and **this** file for the
 * Playwright layer. The unit specs drive the same helpers against a stubbed world; this file
 * drives them the way a lane does — one process, the real modules, the harness's own source
 * tree on disk — and adds the two things a unit spec cannot show: that the refusals hold
 * **for the composition the live lane actually runs** (`assertLaneMayStart`, called from
 * `app-works-live.setup.ts`) and that the static scans see **this** tree, including the three
 * spec files this task adds.
 *
 * ## Measured, not assumed (2026-09-19, this worktree)
 *
 *   - Every refusal below is exercised against the real helper with a hostile env bag, and
 *     each one asserts three things: the refusal happens, it **names the variable** it is
 *     about, and it **never contains the value** it refused (`app-works-live.ts:23-25`: "A
 *     refusal names what it refused and never a value").
 *   - The static half of ACC-13-17 is a real `node:fs` walk of `apps/web/e2e/**` with a
 *     **control assertion** (the walk must have visited this spec and the module under
 *     test), because a scan that silently walks nothing proves nothing. It is the technique
 *     T9's unit spec established, so it also covers the three files this task adds.
 *   - Namespace removal is proven to be refused **before any command runs**: the kubectl
 *     runner is stubbed, so a refusal that still shelled out would show up as a recorded
 *     call — and nothing in this file can reach a cluster.
 *   - ACC-13-16's over-budget failure is asserted through `assertWithinBudget` (reason
 *     exactly `budget`), `budgetExceeded` and the §6.2 summary (`laneSummaryTable`), which is
 *     the spend line "against budget" the case asks for.
 *
 * Nothing here starts a lane, opens a browser or writes to GitHub. The only network calls are
 * the two App Launcher reads of the E2E-12 reference case — the surface APW-11 T20's spec
 * drives — and that case carries a `fixme` naming T20, because this file must **reference**
 * `flow-app-launcher-apps.spec.ts` and never create it (Resolution R-22).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { expect, test } from '@playwright/test';
import { getAppLauncherPlatforms, getMyApps } from './helpers/app-works';
import * as appWorksLive from './helpers/app-works-live';
import {
    APW_E2E,
    APW_INTERLOCKS,
    BudgetExceededError,
    HARNESS_ONLY_GITHUB_TOKEN_VARIABLE,
    PLATFORM_GITHUB_TOKEN_VARIABLE,
    PRODUCTION_ORIGINS,
    TEST_NAMESPACE_PREFIX,
    accountSpend,
    assertAllowedOrigins,
    assertBudgets,
    assertGitHubTokenVariable,
    assertKubeContext,
    assertLaneMayStart,
    assertNoPushAccess,
    assertProposalBaseOwner,
    assertTestNamespace,
    assertUpstreamOwner,
    assertWithinBudget,
    formatSpendLine,
    platformGitHubToken,
    runId,
    runMarker,
    testNamespaceName,
    type InterlockEnv,
} from './helpers/app-works-live';
import { budgetExceeded, laneSummaryTable } from './helpers/app-works-evidence';
import * as githubEstate from './helpers/github-estate';
import {
    WORK_LABEL_KEY,
    TEST_NAMESPACE_PREFIX as K8S_TEST_NAMESPACE_PREFIX,
    deleteTestNamespace,
    setKubectlRunner,
    type KubectlResult,
} from './helpers/k8s-assert';

// ---------------------------------------------------------------------------
// The harness source tree, and the fragments the scans are built from
// ---------------------------------------------------------------------------

/**
 * The HTTP deletion verb, assembled from fragments **on purpose**: the static scan below
 * walks this very file, and a quoted verb within 200 characters of a repository-root path is
 * exactly what it looks for (T9's `github-estate.unit.spec.ts:57-78`). The unit spec builds
 * it the same way, for the same reason.
 */
const HTTP_DELETION_VERB = 'DE' + 'LETE';

/**
 * The estate-wide repository-removal call **by name** (`delete` + `Repository`, assembled
 * here from the same fragments the scan uses) — the call T9's spec proves no lane code
 * makes. Spelled as fragments so this file is not itself a hit.
 */
const REPOSITORY_REMOVAL_CALL = 'delete' + 'Repository';

/** The lane source extensions the walk covers, as T9's spec spells them. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js']);

/**
 * `apps/web/e2e`, resolved from the working directory — a spec may be launched from
 * `apps/web` (the lane) or from the repo root (a direct invocation), the same two candidates
 * `flow-app-work-create-from-url.spec.ts:169-177` uses for its fixture.
 */
function e2eRoot(): string {
    for (const candidate of [
        join(process.cwd(), 'e2e'),
        join(process.cwd(), 'apps', 'web', 'e2e'),
    ]) {
        const stat = statSync(candidate, { throwIfNoEntry: false });
        if (stat?.isDirectory()) return candidate;
    }
    throw new Error(
        `harness-interlocks: could not locate apps/web/e2e from ${process.cwd()} — the static ` +
            'scans cannot run without the tree they are about.',
    );
}

function walkSourceFiles(root: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            found.push(...walkSourceFiles(path));
            continue;
        }
        if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(path);
    }
    return found;
}

/** A path relative to `apps/web/e2e`, with forward slashes, for assertions and messages. */
function relativeToE2e(root: string, file: string): string {
    return relative(root, file).replace(/\\/g, '/');
}

/**
 * A deletion site is the HTTP deletion verb — quoted, or as a method-call form — within 200
 * characters of a path that stops at the repository root (`/repos/<owner>/<repo>` with
 * nothing after it). A path carrying a further segment is a documented sub-resource route
 * (the fake's hook-removal route among them) and is not repository deletion, so it is
 * deliberately not a site. Built from fragments so this spec is not its own finding.
 */
function repositoryDeletionSites(source: string): string[] {
    const sites: string[] = [];
    const verb = new RegExp(`['"\`]${HTTP_DELETION_VERB}['"\`]|\\.de${'lete'}\\s*\\(`);
    const repositoryPath = new RegExp(`\\/re${'pos\\/'}([^\\s'\`"()]*)`, 'g');
    for (const match of source.matchAll(repositoryPath)) {
        const segments = (match[1] ?? '').split('/').filter((segment) => segment.length > 0);
        if (segments.length > 2) continue;
        const start = Math.max(0, (match.index ?? 0) - 200);
        const end = Math.min(source.length, (match.index ?? 0) + match[0].length + 200);
        if (verb.test(source.slice(start, end))) sites.push(match[0]);
    }
    return sites;
}

// ---------------------------------------------------------------------------
// The refusal harness
// ---------------------------------------------------------------------------

/** Run `fn` and hand back the thrown message; fail when it does not refuse at all. */
function refusalOf(fn: () => unknown, what: string): string {
    let message: string | null = null;
    try {
        fn();
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    expect(
        message,
        `${what} must refuse — a check that cannot refuse is not an interlock (ACC-NEG-16)`,
    ).not.toBeNull();
    return message as string;
}

/**
 * Assert a refusal's message: it names what it is about, and it carries no value.
 *
 * `names` are the variable names the message must mention; `values` are the inputs a caller
 * must never find echoed back (`app-works-live.ts:23-25`).
 */
function expectRefusal(message: string, names: string[], values: string[]): void {
    for (const name of names) {
        expect(message, `the refusal names ${name}`).toContain(name);
    }
    for (const value of values) {
        expect(
            message.includes(value),
            `the refusal must never carry the value it refused — found ${JSON.stringify(
                value,
            )} in ${JSON.stringify(message)}`,
        ).toBe(false);
    }
}

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

test('the interlock table is the plan’s seven, each naming an assertion that exists', () => {
    expect(
        APW_INTERLOCKS.map((entry) => entry.id),
        'plan §8.5 fixes seven interlocks; the table is data so none can quietly disappear',
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const entry of APW_INTERLOCKS) {
        expect(entry.name.length, `interlock ${entry.id} has a name`).toBeGreaterThan(0);
        expect(
            typeof (appWorksLive as unknown as Record<string, unknown>)[entry.assertion],
            `interlock ${entry.id} names an export that exists (${entry.assertion})`,
        ).toBe('function');
    }
});

// ---------------------------------------------------------------------------
// ACC-NEG-16 — the refusals
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-16 — the harness refuses to start, naming what it refused', () => {
    test('interlock 1 — an origin outside the allow-list, and a production origin even when listed', () => {
        const wellFormed: InterlockEnv = {
            [APW_E2E.allowedBaseUrls]: 'http://127.0.0.1:3202,http://127.0.0.1:3997',
            [APW_E2E.webOrigin]: 'http://127.0.0.1:3202',
            [APW_E2E.apiOrigin]: 'http://127.0.0.1:3997',
        };
        expect(() => assertAllowedOrigins(wellFormed), 'a well-formed lane starts').not.toThrow();

        // a. No allow-list at all.
        expectRefusal(
            refusalOf(
                () => assertAllowedOrigins({ ...wellFormed, [APW_E2E.allowedBaseUrls]: '' }),
                'an unset allow-list',
            ),
            [APW_E2E.allowedBaseUrls],
            [],
        );

        // b. A production origin *inside* the list: the deny-list is checked first and over
        //    the whole list, so "it was in the list" can never be the reason a lane starts.
        const listedProduction = 'https://app.ever.works';
        const productionRefusal = refusalOf(
            () =>
                assertAllowedOrigins({
                    ...wellFormed,
                    [APW_E2E.allowedBaseUrls]: `${wellFormed[APW_E2E.allowedBaseUrls]},${listedProduction}`,
                }),
            'a production origin listed in the allow-list',
        );
        expect(productionRefusal, 'the refusal names the deny-list').toContain('deny-list');
        expectRefusal(
            productionRefusal,
            [APW_E2E.allowedBaseUrls],
            [listedProduction, ...PRODUCTION_ORIGINS],
        );

        // c. An origin the lane would talk to that is not in the list.
        const stray = 'http://127.0.0.1:9999';
        expectRefusal(
            refusalOf(
                () => assertAllowedOrigins({ ...wellFormed, [APW_E2E.webOrigin]: stray }),
                'a web origin outside the allow-list',
            ),
            [APW_E2E.webOrigin],
            [stray],
        );

        // d. … and the same for the API origin, with everything else in order.
        expectRefusal(
            refusalOf(
                () => assertAllowedOrigins({ ...wellFormed, [APW_E2E.apiOrigin]: stray }),
                'an API origin outside the allow-list',
            ),
            [APW_E2E.apiOrigin],
            [stray],
        );

        // e. A production API origin is refused by the deny-list even while listed.
        const productionApi = 'https://api.ever.works';
        expectRefusal(
            refusalOf(
                () =>
                    assertAllowedOrigins({
                        ...wellFormed,
                        [APW_E2E.allowedBaseUrls]: `${wellFormed[APW_E2E.allowedBaseUrls]},${productionApi}`,
                    }),
                'a listed production API origin',
            ),
            [APW_E2E.allowedBaseUrls],
            [productionApi],
        );
    });

    test('interlock 2 — an unlisted kube context, and read-only apps-tier credentials', () => {
        const listed: InterlockEnv = {
            [APW_E2E.userClusterContext]: 'apw-e2e-user-cluster',
            [APW_E2E.appsTierContext]: 'apw-e2e-apps-tier',
            [APW_E2E.appsTierReadKubeconfig]: '/tmp/apw-e2e-read-only.kubeconfig',
        };
        const unlisted = 'prod-cluster-please-do-not-touch';

        // a. No context variable at all: there is no allow-list to be on.
        expectRefusal(
            refusalOf(
                () => assertKubeContext({ context: unlisted }, {}),
                'a lane with no allow-listed context',
            ),
            [APW_E2E.userClusterContext, APW_E2E.appsTierContext],
            [unlisted],
        );

        // b. A context outside the list.
        expectRefusal(
            refusalOf(
                () => assertKubeContext({ context: unlisted }, listed),
                'an unlisted kube context',
            ),
            [APW_E2E.userClusterContext, APW_E2E.appsTierContext],
            [unlisted],
        );

        // c. Apps-tier credentials are read-only: the context may only be used with the
        //    read-only kubeconfig, and a missing variable is a refusal of its own.
        expectRefusal(
            refusalOf(
                () =>
                    assertKubeContext(
                        { context: 'apw-e2e-apps-tier' },
                        { ...listed, [APW_E2E.appsTierReadKubeconfig]: '' },
                    ),
                'an apps-tier context with no read-only kubeconfig',
            ),
            [APW_E2E.appsTierReadKubeconfig],
            [],
        );
        const writable = '/home/runner/.kube/config';
        expectRefusal(
            refusalOf(
                () =>
                    assertKubeContext(
                        { context: 'apw-e2e-apps-tier', kubeconfigPath: writable },
                        listed,
                    ),
                'an apps-tier context with a writable kubeconfig',
            ),
            [APW_E2E.appsTierReadKubeconfig],
            [writable],
        );

        // d. Controls: the two allow-listed combinations are accepted.
        expect(() => assertKubeContext({ context: 'apw-e2e-user-cluster' }, listed)).not.toThrow();
        expect(() =>
            assertKubeContext(
                {
                    context: 'apw-e2e-apps-tier',
                    kubeconfigPath: '/tmp/apw-e2e-read-only.kubeconfig',
                },
                listed,
            ),
        ).not.toThrow();
    });

    test('interlock 3 — an upstream owner outside APW_E2E_UPSTREAM_ORG, proposal included', () => {
        const listed: InterlockEnv = { [APW_E2E.upstreamOrg]: 'apw-e2e-upstream' };
        const foreign = 'torvalds';

        expectRefusal(
            refusalOf(() => assertUpstreamOwner(foreign, {}), 'an unset upstream org'),
            [APW_E2E.upstreamOrg],
            [foreign],
        );
        expectRefusal(
            refusalOf(
                () => assertUpstreamOwner(foreign, listed),
                'an upstream owner outside the org',
            ),
            [APW_E2E.upstreamOrg],
            [foreign],
        );
        expectRefusal(
            refusalOf(
                () => assertProposalBaseOwner(foreign, listed),
                'a proposal whose base owner is outside the org',
            ),
            [APW_E2E.upstreamOrg],
            [foreign],
        );
        expect(
            refusalOf(() => assertProposalBaseOwner(foreign, listed), 'a foreign proposal'),
            'ACC-NEG-16 names the proposal case explicitly, so the message says which it is',
        ).toContain('proposal');

        // Controls: the allow-listed owner passes, case-insensitively (GitHub logins are).
        expect(() => assertUpstreamOwner('APW-E2E-Upstream', listed)).not.toThrow();
        expect(() => assertProposalBaseOwner('apw-e2e-upstream', listed)).not.toThrow();
    });

    test('interlock 4 — an unset or non-positive spend budget refuses to start', () => {
        const listed: InterlockEnv = {
            [APW_E2E.tokenBudget]: '100000',
            [APW_E2E.actionsMinutesBudget]: '120',
        };
        expect(assertBudgets(listed), 'both caps read as numbers').toEqual({
            tokens: 100000,
            actionsMinutes: 120,
        });

        for (const value of ['', '0', '-5', 'not-a-number']) {
            expectRefusal(
                refusalOf(
                    () => assertBudgets({ ...listed, [APW_E2E.tokenBudget]: value }),
                    `a token budget of ${JSON.stringify(value)}`,
                ),
                [APW_E2E.tokenBudget],
                value === '' ? [] : [value],
            );
            expectRefusal(
                refusalOf(
                    () => assertBudgets({ ...listed, [APW_E2E.actionsMinutesBudget]: value }),
                    `an Actions-minutes budget of ${JSON.stringify(value)}`,
                ),
                [APW_E2E.actionsMinutesBudget],
                value === '' ? [] : [value],
            );
        }

        // An unset variable is a *missing required variable*, which ACC-NEG-16 lists
        // separately — `runId` and `testNamespaceName` are the other two.
        expectRefusal(
            refusalOf(() => runId({}), 'an unset run id'),
            [APW_E2E.runId],
            [],
        );
        expect(
            () => runId({ [APW_E2E.runId]: 'apw-e2e-run-1' }),
            'a declared run id reads',
        ).not.toThrow();
    });

    test('interlock 5 — <e2e-user> must have no push access to the test upstream', () => {
        const login = 'apw-e2e-user';

        // An unread permission set is a refusal of its own — it cannot be mistaken for
        // "no push access" (a missing read is not a green light).
        const unread = refusalOf(
            () => assertNoPushAccess(undefined),
            'an unread upstream permission set',
        );
        expect(unread, 'the refusal says what was not read').toContain('permissions');
        expectRefusal(unread, [], [login]);

        for (const permissions of [{ push: true }, { admin: true }, { maintain: true }]) {
            expectRefusal(
                refusalOf(
                    () => assertNoPushAccess(permissions),
                    `push access ${JSON.stringify(permissions)}`,
                ),
                [APW_E2E.githubUser],
                [login],
            );
        }
        // Control: a read-only relationship passes.
        expect(() => assertNoPushAccess({ pull: true })).not.toThrow();
        expect(() => assertNoPushAccess({ push: false })).not.toThrow();
    });

    test('interlock 6 — the estate token is never passed to the platform', () => {
        expectRefusal(
            refusalOf(
                () => assertGitHubTokenVariable(HARNESS_ONLY_GITHUB_TOKEN_VARIABLE),
                'the harness estate token',
            ),
            [HARNESS_ONLY_GITHUB_TOKEN_VARIABLE],
            [],
        );
        expectRefusal(
            refusalOf(
                () => assertGitHubTokenVariable('SOME_OTHER_GITHUB_TOKEN'),
                'a third variable name',
            ),
            [PLATFORM_GITHUB_TOKEN_VARIABLE],
            ['SOME_OTHER_GITHUB_TOKEN'],
        );
        expect(() => assertGitHubTokenVariable(PLATFORM_GITHUB_TOKEN_VARIABLE)).not.toThrow();

        // The value itself: a lane whose platform token *is* the estate credential is
        // refused, and the refusal names variables rather than the credential.
        const shared = 'ghp_this-must-never-be-echoed-0123456789';
        expectRefusal(
            refusalOf(
                () =>
                    platformGitHubToken({
                        [PLATFORM_GITHUB_TOKEN_VARIABLE]: shared,
                        [HARNESS_ONLY_GITHUB_TOKEN_VARIABLE]: shared,
                    }),
                'the same credential in both roles',
            ),
            [],
            [shared],
        );
        expect(
            platformGitHubToken({
                [PLATFORM_GITHUB_TOKEN_VARIABLE]: shared,
                [HARNESS_ONLY_GITHUB_TOKEN_VARIABLE]: 'another-credential',
            }),
            'a distinct platform token is returned for the platform',
        ).toBe(shared);
    });

    test('interlock 7 — a test namespace name, and the run-unique names built from the run id', () => {
        expect(() => assertTestNamespace(`${TEST_NAMESPACE_PREFIX}run-1-fixture`)).not.toThrow();
        expectRefusal(
            refusalOf(() => assertTestNamespace('production-apps'), 'an unprefixed namespace'),
            [TEST_NAMESPACE_PREFIX],
            ['production-apps'],
        );
        // An empty name is refused too: "required" is its own refusal, with no value to name.
        expect(refusalOf(() => assertTestNamespace(''), 'an empty namespace name')).toContain(
            'required',
        );

        const env: InterlockEnv = { [APW_E2E.runId]: 'apw-e2e-run-1' };
        expect(testNamespaceName('fixture', env)).toBe(
            `${TEST_NAMESPACE_PREFIX}apw-e2e-run-1-fixture`,
        );
        expect(runMarker('marker', env)).toBe('apw-e2e-run-1-marker');
        expect(runId(env)).toBe('apw-e2e-run-1');
    });

    test('the composition the live lane runs refuses a hostile bag, and the lane calls it', () => {
        // What `app-works-live.setup.ts` runs. A lane that drifted onto a production origin,
        // an unlisted context and a non-test upstream, with no budget, must not start — and
        // the first interlock of plan §8.5 is the one that answers.
        const hostileBag: InterlockEnv = {
            [APW_E2E.allowedBaseUrls]: 'https://app.ever.works',
            [APW_E2E.webOrigin]: 'https://app.ever.works',
            [APW_E2E.apiOrigin]: 'https://api.ever.works',
        };
        const hostile = refusalOf(
            () =>
                assertLaneMayStart(
                    {
                        kube: { context: 'prod-cluster-please-do-not-touch' },
                        upstreamOwner: 'torvalds',
                        proposalBaseOwner: 'torvalds',
                        upstreamPermissions: { push: true },
                        requestedGitHubTokenVariable: HARNESS_ONLY_GITHUB_TOKEN_VARIABLE,
                        namespaces: ['production-apps'],
                    },
                    hostileBag,
                ),
            'a hostile lane',
        );
        expect(
            hostile,
            'the refusals run in plan §8.5 order, so origin interlock 1 answers first',
        ).toContain(APW_E2E.allowedBaseUrls);
        expect(hostile).toContain('deny-list');

        const wellFormed: InterlockEnv = {
            [APW_E2E.allowedBaseUrls]: 'http://127.0.0.1:3202,http://127.0.0.1:3997',
            [APW_E2E.webOrigin]: 'http://127.0.0.1:3202',
            [APW_E2E.apiOrigin]: 'http://127.0.0.1:3997',
            [APW_E2E.userClusterContext]: 'apw-e2e-user-cluster',
            [APW_E2E.upstreamOrg]: 'apw-e2e-upstream',
            [APW_E2E.tokenBudget]: '100000',
            [APW_E2E.actionsMinutesBudget]: '120',
            [APW_E2E.runId]: 'apw-e2e-run-1',
        };
        expect(
            () =>
                assertLaneMayStart(
                    {
                        kube: { context: 'apw-e2e-user-cluster' },
                        upstreamOwner: 'apw-e2e-upstream',
                        proposalBaseOwner: 'apw-e2e-upstream',
                        upstreamPermissions: { pull: true },
                        requestedGitHubTokenVariable: PLATFORM_GITHUB_TOKEN_VARIABLE,
                        namespaces: [`${TEST_NAMESPACE_PREFIX}apw-e2e-run-1-fixture`],
                    },
                    wellFormed,
                ),
            'a well-formed lane starts',
        ).not.toThrow();

        // The interlocks are wired into the lane, not merely available to it: the setup
        // project the live lanes run must call the composition (and the connection probe).
        const root = e2eRoot();
        const setup = readFileSync(join(root, 'app-works-live.setup.ts'), 'utf8');
        expect(
            setup,
            'T12’s setup project runs the seven interlocks before any scenario',
        ).toContain('assertLaneMayStart(');
        expect(
            setup,
            'and asserts the GitHub connection surface rather than failing at the first fork',
        ).toContain('assertGitHubConnection(');
    });
});

// ---------------------------------------------------------------------------
// ACC-13-17 — no lane code path can delete a repository; namespaces only where allowed
// ---------------------------------------------------------------------------

test.describe('ACC-13-17 — the lane cannot delete a repository, and namespaces only where allowed', () => {
    test('the static scan finds no repository-deletion site anywhere under apps/web/e2e', () => {
        const root = e2eRoot();
        const files = walkSourceFiles(root);

        // Control: the walk really covered the harness — an empty or partial walk would make
        // every assertion below vacuous.
        expect(files.length, 'the walk covers the harness').toBeGreaterThan(10);
        const relatives = files.map((file) => relativeToE2e(root, file));
        expect(relatives).toContain('helpers/github-estate.ts');
        expect(relatives).toContain('flow-app-works-harness-interlocks.spec.ts');
        expect(relatives).toContain('flow-app-work-delete-retains.spec.ts');
        expect(relatives).toContain('flow-app-work-target-none.spec.ts');

        const deletionSites = files
            .map((file) => ({
                file: relativeToE2e(root, file),
                sites: repositoryDeletionSites(readFileSync(file, 'utf8')),
            }))
            .filter((entry) => entry.sites.length > 0);
        expect(
            deletionSites,
            'ACC-13-17: no spec or helper calls a repository-delete endpoint ' +
                `(sites=${JSON.stringify(deletionSites)})`,
        ).toEqual([]);

        const namedCallers = files
            .filter((file) => readFileSync(file, 'utf8').includes(REPOSITORY_REMOVAL_CALL))
            .map((file) => relativeToE2e(root, file));
        expect(namedCallers, `no lane code calls ${REPOSITORY_REMOVAL_CALL} by name`).toEqual([]);
    });

    test('the estate helper’s export surface contains no removal, and no deletion verb', () => {
        const removalNames = Object.entries(githubEstate)
            .filter(([, value]) => typeof value === 'function')
            .map(([name, value]) => `${name}/${(value as { name?: string }).name ?? ''}`)
            .filter((names) => /delete|remove|destroy/i.test(names));
        expect(
            removalNames,
            'the module a lane reaches GitHub through exports nothing named for a removal',
        ).toEqual([]);

        const source = readFileSync(join(e2eRoot(), 'helpers', 'github-estate.ts'), 'utf8');
        expect(
            source.includes(HTTP_DELETION_VERB),
            'the module cannot build the HTTP deletion verb at all',
        ).toBe(false);
        expect(
            repositoryDeletionSites(source),
            'and names no repository-root deletion site',
        ).toEqual([]);
    });

    test('deleteTestNamespace refuses before any command, and issues one only where allowed', async () => {
        const recorded: Array<{ args: string[]; input?: string }> = [];
        const stub = async (args: string[], input?: string): Promise<KubectlResult> => {
            recorded.push({ args, input });
            return { stdout: 'namespace "…" deleted', stderr: '', code: 0 };
        };
        const previous = {
            user: process.env.APW_E2E_USER_CLUSTER_CONTEXT,
            apps: process.env.APW_E2E_APPS_TIER_CONTEXT,
        };
        setKubectlRunner(stub);
        try {
            // a. A namespace that is not recognisably ephemeral, with a context that is
            //    allow-listed: refused, and no command ran.
            delete process.env.APW_E2E_USER_CLUSTER_CONTEXT;
            delete process.env.APW_E2E_APPS_TIER_CONTEXT;
            await expect(
                deleteTestNamespace('default', { context: 'apw-e2e-user-cluster' }),
            ).rejects.toThrow(new RegExp(K8S_TEST_NAMESPACE_PREFIX));
            expect(recorded, 'an unprefixed namespace never reaches kubectl').toEqual([]);

            // b. A prefixed namespace with no allow-listed context: refused, no command.
            await expect(
                deleteTestNamespace(`${K8S_TEST_NAMESPACE_PREFIX}run-1-fixture`, {
                    context: 'prod-cluster',
                }),
            ).rejects.toThrow(/allow-listed/);
            expect(recorded, 'an unlisted context never reaches kubectl').toEqual([]);

            // c. A prefixed namespace in an allow-listed context: exactly one command, and
            //    it is the documented one (`--context <ctx> delete namespace <name>`).
            process.env.APW_E2E_USER_CLUSTER_CONTEXT = 'apw-e2e-user-cluster';
            const result = await deleteTestNamespace(`${K8S_TEST_NAMESPACE_PREFIX}run-1-fixture`, {
                context: 'apw-e2e-user-cluster',
            });
            expect(result.code).toBe(0);
            expect(
                recorded.map((entry) => entry.args),
                'the only removal the harness can issue',
            ).toEqual([
                [
                    '--context',
                    'apw-e2e-user-cluster',
                    'delete',
                    'namespace',
                    `${K8S_TEST_NAMESPACE_PREFIX}run-1-fixture`,
                    '--wait=false',
                ],
            ]);
        } finally {
            setKubectlRunner(undefined);
            if (previous.user === undefined) delete process.env.APW_E2E_USER_CLUSTER_CONTEXT;
            else process.env.APW_E2E_USER_CLUSTER_CONTEXT = previous.user;
            if (previous.apps === undefined) delete process.env.APW_E2E_APPS_TIER_CONTEXT;
            else process.env.APW_E2E_APPS_TIER_CONTEXT = previous.apps;
        }
    });

    test('the App Work label the scans and the namespace cleanup agree on', () => {
        // The label is what makes "no Kubernetes object carries this App Work's labels"
        // (ACC-E2E-11) checkable at all, so the lane and the helpers must spell it the same.
        expect(WORK_LABEL_KEY).toBe('ever-works.io/part-of');
        expect(appWorksLive.TEST_NAMESPACE_PREFIX).toBe(K8S_TEST_NAMESPACE_PREFIX);
    });
});

// ---------------------------------------------------------------------------
// ACC-13-16 — over budget fails with reason `budget`, and the summary shows spend
// ---------------------------------------------------------------------------

test.describe('ACC-13-16 — a run over budget fails with reason budget', () => {
    test('a spend over either cap fails with reason budget, and the summary says so', () => {
        const budget = { actionsMinutes: 10, tokens: 100 };

        // Under budget: no failure, and the spend line is still there.
        const within = { actionsMinutes: 10, tokens: 100 };
        expect(() => assertWithinBudget(within, budget), 'the caps are inclusive').not.toThrow();
        const withinVerdict = budgetExceeded(within, budget);
        expect(withinVerdict).toEqual({
            exceeded: false,
            reason: null,
            over: { actionsMinutes: false, tokens: false },
        });

        const over = { actionsMinutes: 11, tokens: 100 };
        const verdict = budgetExceeded(over, budget);
        expect(verdict.reason, 'ACC-13-16: the reason is exactly `budget`').toBe('budget');
        expect(verdict.over.actionsMinutes).toBe(true);
        expect(verdict.over.tokens).toBe(false);

        let thrown: unknown;
        try {
            assertWithinBudget(over, budget);
        } catch (error) {
            thrown = error;
        }
        expect(thrown, 'an over-budget spend must fail').toBeInstanceOf(BudgetExceededError);
        const failure = thrown as BudgetExceededError;
        expect(failure.reason).toBe('budget');
        expect(failure.message.startsWith('budget:'), `message=${failure.message}`).toBe(true);
        expect(failure.message).toContain('reason: budget');
        expect(failure.spend).toEqual(over);
        expect(failure.budgets).toEqual(budget);

        // The §6.2 summary the case asks for: the spend line against budget, and the
        // failure line when the run is over.
        const rows = [
            {
                scenarioId: 'ACC-E2E-11',
                step: 'create with Deploy target None',
                result: 'pass',
                seconds: 12,
            },
            { scenarioId: 'ACC-13-16', step: 'run summary', result: 'pass' },
        ];
        const summary = laneSummaryTable({ rows, spend: over, budget, leftBehind: [] });
        expect(summary, 'the spend line shows spend against budget').toContain(
            `**${formatSpendLine(over, budget)}**`,
        );
        expect(formatSpendLine(over, budget)).toBe(
            'Spend: 11 / 10 Actions minutes · 100 / 100 tokens',
        );
        expect(summary).toContain('**Run failed: reason `budget`**');
        expect(summary).toContain('(over: actionsMinutes)');
        expect(summary, 'the summary is the §6.2 table').toContain(
            '| Scenario | Step | Result | Duration | First failing observation | Evidence |',
        );

        const fine = laneSummaryTable({ rows, spend: within, budget, leftBehind: [] });
        expect(fine).toContain(`**${formatSpendLine(within, budget)}**`);
        expect(fine, 'a run inside its budget carries no failure line').not.toContain('Run failed');
    });

    test('the spend the summary is built from counts the Run and Build receipts once each', () => {
        const spend = accountSpend([
            { kind: 'run', tokens: 1200, actionsMinutes: 3 },
            // `billableMinutes` already includes the checks matrix (plan §9.6), so the
            // checks figure must NOT be added again on top of it.
            { kind: 'build', billableMinutes: 4, checksBillableMinutes: 2 },
            // A receipt that carries only the checks figure contributes exactly that.
            { kind: 'build', checksBillableMinutes: 2 },
            // An explicit `actionsMinutes` wins; the checks figure is then not counted.
            { kind: 'build', actionsMinutes: 5, checksBillableMinutes: 7 },
        ]);
        expect(spend).toEqual({ actionsMinutes: 3 + 4 + 2 + 5, tokens: 1200 });

        expect(() =>
            accountSpend([{ kind: 'deploy' as unknown as 'run', actionsMinutes: 1 }]),
        ).toThrow(/neither a Run nor a Build receipt/);
    });
});

// ---------------------------------------------------------------------------
// ACC-E2E-12 — the App Launcher lane, referenced and not owned (Resolution R-22)
// ---------------------------------------------------------------------------

test.describe('ACC-E2E-12 — the App Launcher lane APW-13 references', () => {
    test('the launcher read surface E2E-12 drives is mounted, or refused as documented', async ({
        request,
    }) => {
        // The public platform list is E2E-12's first read (APW-11 FR-37) and needs no session.
        const platforms = await getAppLauncherPlatforms(request);
        expect(
            platforms.status,
            `GET /api/app-launcher/platforms body=${platforms.text.slice(0, 200)}`,
        ).toBe(200);

        // The session list is the read E2E-12 asserts item by item. Without a session it is
        // `401` when the launcher is on and `404` when it is off — ACC-E2E-12 documents the
        // 404 as the flag-off state, and the runbook's §4 recipe does not set
        // `EVER_WORKS_APP_LAUNCHER_ENABLED`.
        const session = await getMyApps(request);
        expect(
            [401, 404],
            `GET /api/me/apps answered ${session.status} — expected 401 (launcher on, no ` +
                'session) or 404 (launcher off, ACC-E2E-12’s documented off state)',
        ).toContain(session.status);
    });

    /**
     * E2E-12's spec file is **APW-11 T20's** (`ACCEPTANCE.md:596`: "created by APW-11 T20;
     * APW-13 references it"; Resolution R-22), and T33's Done-when says "this epic's diff
     * adds no `flow-app-launcher-apps.spec.ts`".
     *
     * **Measured in this worktree on 2026-09-19: the file did not exist** —
     * `apps/web/e2e/flow-app-launcher-apps.spec.ts` was absent, and the only two `flow-app-*`
     * specs present were T30's and T31's — so this case carried a `test.fixme` naming APW-11
     * T20 as the epic that owed it, rather than hiding the gap.
     *
     * **Lifted the same day, by T20 landing**: the marker's own body is now the check it was
     * written to become. It asserts the file is really there and that it carries an
     * `ACC-E2E-12` case, so a placeholder — or a rename that dropped the acceptance id — fails
     * here rather than leaving the interlock silently satisfied.
     */
    test('APW-11 T20 landed: apps/web/e2e/flow-app-launcher-apps.spec.ts exists and carries ACC-E2E-12', async () => {
        const root = e2eRoot();
        const path = join(root, 'flow-app-launcher-apps.spec.ts');
        const stat = statSync(path, { throwIfNoEntry: false });
        expect(stat?.isFile(), 'APW-11 T20 creates this file').toBe(true);

        const source = readFileSync(path, 'utf8');
        expect(
            source.includes('ACC-E2E-12'),
            'the file T20 creates is the E2E-12 lane spec, not an empty placeholder',
        ).toBe(true);
    });
});
