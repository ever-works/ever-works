/**
 * Unit spec for the live-lane helpers (APW-13 T8, `tasks.md:130-138`).
 *
 * The safety half of the acceptance harness, tested as refusals:
 *
 *   - **Every one of the seven interlocks refuses its bad input.** A lane that
 *     cannot refuse is a lane nobody can leave unattended (ACC-NEG-16, S10/S11).
 *   - **The production deny-list wins over a misconfigured allow-list.** A
 *     production origin listed in `APW_E2E_ALLOWED_BASE_URLS` is still refused —
 *     the check that makes "it was in the list" impossible as an excuse.
 *   - **Redaction works on nested JSON and on plain text**, over every
 *     `APW_E2E_*` secret value and the honeytoken, and never mutates the
 *     artefact it was handed (plan §8.7).
 *   - **A budget overrun fails with reason `budget`** (ACC-13-16) — the exact
 *     reason string the run summary and the lane's exit path depend on.
 *
 * No test here touches `process.env`: every helper takes the env bag as a
 * parameter, which is the injection point this spec uses.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as live from '../app-works-live';
import {
    APW_E2E,
    APW_INTERLOCKS,
    BudgetExceededError,
    ESTATE_RELATIVE_PATH,
    PRODUCTION_ORIGINS,
    accountSpend,
    assertAllowedOrigins,
    assertBudgets,
    assertGitHubTokenVariable,
    assertKubeContext,
    assertLaneMayStart,
    assertNoPushAccess,
    assertNoSecretLeak,
    assertProposalBaseOwner,
    assertTestNamespace,
    assertUpstreamOwner,
    assertWithinBudget,
    budgetsFromEnv,
    defaultEstatePath,
    emptyEstate,
    estateExists,
    findSecretLeaks,
    formatSpendLine,
    isProductionOrigin,
    platformGitHubToken,
    readEstate,
    redact,
    runId,
    runMarker,
    secretVariableNames,
    testNamespaceName,
    updateEstate,
    writeEstate,
    type InterlockEnv,
    type RunReceipt,
} from '../app-works-live';

/** A lane configuration that passes every interlock. */
function goodEnv(): InterlockEnv {
    return {
        [APW_E2E.allowedBaseUrls]: 'https://dev.ever-works.test,http://127.0.0.1:3100',
        [APW_E2E.webOrigin]: 'https://dev.ever-works.test',
        [APW_E2E.apiOrigin]: 'http://127.0.0.1:3100',
        [APW_E2E.userClusterContext]: 'kind-apw-e2e',
        [APW_E2E.appsTierContext]: 'apw-tier-read',
        [APW_E2E.appsTierReadKubeconfig]: '/tmp/apw-tier-read.yaml',
        [APW_E2E.upstreamOrg]: 'ever-works',
        [APW_E2E.tokenBudget]: '1200000',
        [APW_E2E.actionsMinutesBudget]: '225',
        [APW_E2E.githubUser]: 'evereq',
        [APW_E2E.githubUserToken]: 'ghp_unit_user_token_value',
        [APW_E2E.githubEstateToken]: 'ghp_unit_estate_token_value',
        [APW_E2E.honeyToken]: 'apw-honeytoken-9f3c1d',
        [APW_E2E.runId]: 'run-2026-09-17-unit',
        [APW_E2E.lane]: 'nightly',
    };
}

/** Run `fn` and return the error it threw, failing the test when it does not throw. */
function catchError(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected the call to be refused, but it returned');
}

const tempDirs: string[] = [];

/** A fresh temp directory for an estate-file test. */
function tempEstatePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'apw-estate-'));
    tempDirs.push(dir);
    return join(dir, '.auth', 'app-works-estate.json');
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop() as string;
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('app-works-live: the seven interlocks of plan §8.5 exist (T8)', () => {
    it('lists interlock 1..7, each with an exported assertion', () => {
        expect(APW_INTERLOCKS.map((interlock) => interlock.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        const missing = APW_INTERLOCKS.filter(
            (interlock) =>
                typeof (live as unknown as Record<string, unknown>)[interlock.assertion] !==
                'function',
        ).map((interlock) => `${interlock.id}:${interlock.assertion}`);
        expect(missing, 'every interlock names an exported assertion').toEqual([]);
    });

    it('refuses the whole lane when one interlock fails', () => {
        const env = goodEnv();
        assertLaneMayStart(
            {
                kube: { context: 'kind-apw-e2e' },
                upstreamOwner: 'ever-works',
                proposalBaseOwner: 'EVER-WORKS',
                upstreamPermissions: { push: false, admin: false, pull: true },
                requestedGitHubTokenVariable: APW_E2E.githubUserToken,
                namespaces: ['apw-e2e-run-2026-09-17-unit-fixture'],
            },
            env,
        );
        expect(() =>
            assertLaneMayStart(
                {
                    kube: { context: 'kind-apw-e2e' },
                    namespaces: ['default'],
                },
                env,
            ),
        ).toThrow(/must start with apw-e2e-/);
    });
});

describe('app-works-live: interlock 1 — origins and the production deny-list', () => {
    it('refuses an absent allow-list', () => {
        const env = goodEnv();
        delete env[APW_E2E.allowedBaseUrls];
        expect(() => assertAllowedOrigins(env)).toThrow(/APW_E2E_ALLOWED_BASE_URLS is not set/);
    });

    it('refuses an origin that is not in the allow-list, naming the variable', () => {
        const env = goodEnv();
        env[APW_E2E.apiOrigin] = 'https://somewhere-else.test';
        const error = catchError(() => assertAllowedOrigins(env));
        expect(error.message).toContain('API_URL is not in APW_E2E_ALLOWED_BASE_URLS');
        expect(error.message, 'a refusal never carries the value it refused').not.toContain(
            'somewhere-else.test',
        );
    });

    it('refuses a production origin inside a misconfigured allow-list', () => {
        const env = goodEnv();
        // The list itself is wrong: a valid dev origin plus a production one.
        env[APW_E2E.allowedBaseUrls] =
            'https://dev.ever-works.test,https://api.ever.works,http://127.0.0.1:3100';
        const error = catchError(() => assertAllowedOrigins(env));
        expect(error.message).toContain('APW_E2E_ALLOWED_BASE_URLS lists a production origin');
        expect(error.message).toContain('hard-coded deny-list');
        expect(error.message).not.toContain('api.ever.works');
    });

    it('refuses a production origin even when it is the only listed origin', () => {
        const env = goodEnv();
        env[APW_E2E.allowedBaseUrls] = 'https://api.ever.works';
        env[APW_E2E.apiOrigin] = 'https://api.ever.works';
        expect(() => assertAllowedOrigins(env)).toThrow(/lists a production origin/);
    });

    it('refuses a production web origin that the allow-list also lists', () => {
        const env = goodEnv();
        env[APW_E2E.allowedBaseUrls] = 'https://app.ever.works,http://127.0.0.1:3100';
        env[APW_E2E.webOrigin] = 'https://app.ever.works';
        env[APW_E2E.apiOrigin] = 'http://127.0.0.1:3100';
        expect(() => assertAllowedOrigins(env)).toThrow(/lists a production origin/);
    });

    it('recognises production hosts, and allows a per-App subdomain of the platform domain', () => {
        expect(isProductionOrigin('https://api.ever.works')).toBe(true);
        expect(isProductionOrigin('https://API.EVER.WORKS/')).toBe(true);
        expect(isProductionOrigin('https://app.gauzy.co')).toBe(true);
        expect(isProductionOrigin('https://ever.works')).toBe(true);
        expect(PRODUCTION_ORIGINS).toContain('api.ever.works');
        // R-16: `<slug>.ever.works` is the ordinary managed address, not production.
        expect(isProductionOrigin('https://fixture-1.ever.works')).toBe(false);
        expect(isProductionOrigin('https://dev.ever-works.test')).toBe(false);
        expect(isProductionOrigin(undefined)).toBe(false);
    });

    it('accepts a dev/stage configuration', () => {
        expect(() => assertAllowedOrigins(goodEnv())).not.toThrow();
    });
});

describe('app-works-live: interlock 2 — kube contexts, apps-tier read-only', () => {
    const env = goodEnv();

    it('refuses an unlisted context without naming it', () => {
        const error = catchError(() => assertKubeContext({ context: 'prod-ever-k8s' }, env));
        expect(error.message).toContain('not one of the allow-listed contexts');
        expect(error.message).toContain(APW_E2E.userClusterContext);
        expect(error.message).not.toContain('prod-ever-k8s');
    });

    it('refuses a missing context outright', () => {
        expect(() => assertKubeContext({}, env)).toThrow(/no kube context was given/);
    });

    it('refuses the apps-tier context without the read-only kubeconfig', () => {
        const withoutRead = goodEnv();
        delete withoutRead[APW_E2E.appsTierReadKubeconfig];
        expect(() =>
            assertKubeContext(
                { context: 'apw-tier-read', kubeconfigPath: '/tmp/any.yaml' },
                withoutRead,
            ),
        ).toThrow(/apps-tier credentials are read-only/);
    });

    it('refuses the apps-tier context with any other kubeconfig', () => {
        expect(() =>
            assertKubeContext(
                { context: 'apw-tier-read', kubeconfigPath: '/home/me/.kube/config' },
                env,
            ),
        ).toThrow(/may only be used with the read-only APW_E2E_APPS_TIER_READ_KUBECONFIG/);
    });

    it('accepts both allow-listed contexts with their credentials', () => {
        expect(() => assertKubeContext({ context: 'kind-apw-e2e' }, env)).not.toThrow();
        expect(() =>
            assertKubeContext(
                { context: 'apw-tier-read', kubeconfigPath: '/tmp/apw-tier-read.yaml' },
                env,
            ),
        ).not.toThrow();
    });

    it('refuses when no context is allow-listed at all', () => {
        expect(() => assertKubeContext({ context: 'anything' }, {})).toThrow(
            /neither APW_E2E_USER_CLUSTER_CONTEXT nor APW_E2E_APPS_TIER_CONTEXT is set/,
        );
    });
});

describe('app-works-live: interlock 3 — the test upstream only', () => {
    it('refuses an upstream owner outside APW_E2E_UPSTREAM_ORG', () => {
        const env = goodEnv();
        const error = catchError(() => assertUpstreamOwner('calcom', env));
        expect(error.message).toContain('outside APW_E2E_UPSTREAM_ORG');
        expect(error.message).not.toContain('calcom');
    });

    it('refuses a proposal whose base owner is outside it, naming the proposal', () => {
        const error = catchError(() => assertProposalBaseOwner('calcom', goodEnv()));
        expect(error.message).toContain('upstream PR proposal base owner');
        expect(error.message).not.toContain('calcom');
    });

    it('accepts the configured organization, case-insensitively', () => {
        expect(() => assertUpstreamOwner('EVER-WORKS', goodEnv())).not.toThrow();
        expect(() => assertProposalBaseOwner('ever-works', goodEnv())).not.toThrow();
    });

    it('refuses an unset organization or a missing owner', () => {
        expect(() => assertUpstreamOwner('ever-works', {})).toThrow(
            /APW_E2E_UPSTREAM_ORG is not set/,
        );
        expect(() => assertUpstreamOwner(undefined, goodEnv())).toThrow(/owner is missing/);
    });
});

describe('app-works-live: interlock 4 — both spend caps', () => {
    it('refuses an unset token budget', () => {
        const env = goodEnv();
        delete env[APW_E2E.tokenBudget];
        expect(() => assertBudgets(env)).toThrow(/APW_E2E_TOKEN_BUDGET is not set/);
    });

    it('refuses an unset Actions-minutes budget', () => {
        const env = goodEnv();
        delete env[APW_E2E.actionsMinutesBudget];
        expect(() => assertBudgets(env)).toThrow(/APW_E2E_ACTIONS_MINUTES_BUDGET is not set/);
    });

    it.each(['0', '-1', 'lots'])('refuses the non-positive budget %s', (value) => {
        const env = goodEnv();
        env[APW_E2E.actionsMinutesBudget] = value;
        expect(() => assertBudgets(env)).toThrow(/is not a positive number/);
    });

    it('returns both caps as numbers', () => {
        expect(assertBudgets(goodEnv())).toEqual({ tokens: 1_200_000, actionsMinutes: 225 });
        expect(budgetsFromEnv(goodEnv()).tokens).toBe(1_200_000);
    });
});

describe('app-works-live: interlock 5 — no push access to the test upstream', () => {
    it('refuses push, and refuses the permissions it implies', () => {
        expect(() => assertNoPushAccess({ push: true })).toThrow(/has write access/);
        expect(() => assertNoPushAccess({ admin: true, push: false })).toThrow(/has write access/);
        expect(() => assertNoPushAccess({ maintain: true })).toThrow(/has write access/);
    });

    it('refuses a missing permissions read rather than assuming it is safe', () => {
        expect(() => assertNoPushAccess(undefined)).toThrow(/permissions were not read/);
    });

    it('accepts a read-only account', () => {
        expect(() => assertNoPushAccess({ admin: false, push: false, pull: true })).not.toThrow();
    });
});

describe('app-works-live: interlock 6 — the estate token never reaches the platform', () => {
    it('refuses APW_E2E_GITHUB_ESTATE_TOKEN by name', () => {
        const error = catchError(() => assertGitHubTokenVariable(APW_E2E.githubEstateToken));
        expect(error.message).toContain('APW_E2E_GITHUB_ESTATE_TOKEN is harness-only');
        expect(error.message).toContain('never passed to the platform');
    });

    it('refuses every other variable name', () => {
        expect(() => assertGitHubTokenVariable('APW_E2E_CANARY_SINK_READ_TOKEN')).toThrow(
            /only APW_E2E_GITHUB_USER_TOKEN may be attached/,
        );
        expect(() => assertGitHubTokenVariable('GITHUB_TOKEN')).toThrow(
            /only APW_E2E_GITHUB_USER_TOKEN may be attached/,
        );
    });

    it('reads the user token, and only the user token', () => {
        const env = goodEnv();
        expect(platformGitHubToken(env)).toBe('ghp_unit_user_token_value');
        const onlyEstate: InterlockEnv = {
            [APW_E2E.githubEstateToken]: 'ghp_unit_estate_token_value',
        };
        expect(() => platformGitHubToken(onlyEstate)).toThrow(
            /APW_E2E_GITHUB_USER_TOKEN is not set/,
        );
    });

    it('refuses a run whose user token is the estate token', () => {
        const env = goodEnv();
        env[APW_E2E.githubUserToken] = 'ghp_unit_estate_token_value';
        expect(() => platformGitHubToken(env)).toThrow(/estate credential/);
    });
});

describe('app-works-live: interlock 7 — the apw-e2e- namespace prefix', () => {
    it('refuses any name without the prefix, without echoing it', () => {
        const error = catchError(() => assertTestNamespace('default'));
        expect(error.message).toContain('must start with apw-e2e-');
        expect(error.message).not.toContain('default');
        expect(() => assertTestNamespace('apw-e2e')).toThrow(/must start with apw-e2e-/);
        expect(() => assertTestNamespace('')).toThrow(/namespace name is required/);
    });

    it('accepts a prefixed name and builds one from the run id', () => {
        expect(() => assertTestNamespace('apw-e2e-run-1-fixture')).not.toThrow();
        expect(testNamespaceName('fixture', goodEnv())).toBe('apw-e2e-run-2026-09-17-unit-fixture');
    });
});

describe('app-works-live: run id, markers and the estate file (plan §3.2)', () => {
    it('seeds markers from APW_E2E_RUN_ID and refuses a run without one', () => {
        expect(runId(goodEnv())).toBe('run-2026-09-17-unit');
        expect(runMarker('Greeting Change', goodEnv())).toBe('run-2026-09-17-unit-greeting-change');
        expect(runMarker(undefined, goodEnv())).toBe('run-2026-09-17-unit-marker');
        expect(() => runMarker('x', {})).toThrow(/APW_E2E_RUN_ID is not set/);
    });

    it('points at e2e/.auth/app-works-estate.json unless overridden', () => {
        expect(ESTATE_RELATIVE_PATH).toBe('e2e/.auth/app-works-estate.json');
        expect(defaultEstatePath(goodEnv()).replace(/\\/g, '/')).toContain(
            'apps/web/e2e/.auth/app-works-estate.json',
        );
        expect(
            defaultEstatePath({ [APW_E2E.estatePath]: 'apw-estate-custom.json' }).replace(
                /\\/g,
                '/',
            ),
        ).toContain('apw-estate-custom.json');
    });

    it('round-trips the estate file, and merges updates additively', () => {
        const path = tempEstatePath();
        expect(estateExists({ path })).toBe(false);
        expect(() => readEstate({ path })).toThrow(/no App Works estate file at/);

        writeEstate(
            {
                ...emptyEstate('run-1', 'nightly', '2026-09-17T00:00:00.000Z'),
                repositories: ['ever-works-e2e/app-fixture-hello'],
                appWorkIds: ['work-1'],
                namespaces: ['apw-e2e-run-1-fixture'],
                pullRequestNumbers: [42],
            },
            { path },
        );

        const read = readEstate({ path });
        expect(read.runId).toBe('run-1');
        expect(read.repositories).toEqual(['ever-works-e2e/app-fixture-hello']);
        expect(read.appWorkIds).toEqual(['work-1']);
        expect(read.namespaces).toEqual(['apw-e2e-run-1-fixture']);
        expect(read.pullRequestNumbers).toEqual([42]);

        const merged = updateEstate(
            { appWorkIds: ['work-2'], pullRequestNumbers: [42, 43] },
            { path },
        );
        expect(merged.appWorkIds).toEqual(['work-1', 'work-2']);
        expect(merged.pullRequestNumbers, 'merging deduplicates').toEqual([42, 43]);
        expect(readEstate({ path }).namespaces).toEqual(['apw-e2e-run-1-fixture']);
    });

    it('refuses to record a namespace that interlock 7 would refuse', () => {
        const path = tempEstatePath();
        expect(() =>
            writeEstate(
                { ...emptyEstate('run-1'), namespaces: ['apw-e2e-ok', 'kube-system'] },
                { path },
            ),
        ).toThrow(/must start with apw-e2e-/);
        expect(estateExists({ path }), 'a refused write leaves no file behind').toBe(false);
    });

    it('refuses a malformed estate file instead of half-reading it', () => {
        const path = tempEstatePath();
        writeEstate(emptyEstate('run-1'), { path }); // creates the .auth/ directory
        writeFileSync(path, '{"repositories": "not-an-array"}', 'utf8');
        expect(() => readEstate({ path })).toThrow(/has no run id/);

        writeFileSync(
            path,
            '{"runId":"run-1","namespaces":["apw-e2e-x"],"repositories":[1]}',
            'utf8',
        );
        expect(() => readEstate({ path })).toThrow(/non-string repositories list/);

        writeFileSync(path, 'not json at all', 'utf8');
        expect(() => readEstate({ path })).toThrow(/is not valid JSON/);
    });
});

describe('app-works-live: redaction over nested JSON and plain text (plan §8.7)', () => {
    it('names every secret-valued lane variable, and not the caps', () => {
        const names = secretVariableNames(goodEnv());
        expect(names).toContain(APW_E2E.githubUserToken);
        expect(names).toContain(APW_E2E.githubEstateToken);
        expect(names).toContain(APW_E2E.honeyToken);
        expect(names, 'a budget is a cap, not a credential').not.toContain(APW_E2E.tokenBudget);
    });

    it('redacts a secret inside nested JSON, without mutating the input', () => {
        const env = goodEnv();
        const artefact = {
            trace: {
                requests: [
                    {
                        url: 'https://api.test/x',
                        headers: { authorization: `Bearer ${env[APW_E2E.githubUserToken]}` },
                    },
                ],
                console: [{ text: `planted ${env[APW_E2E.honeyToken]} in the env entry` }],
            },
            env: { APW_E2E_LANE: 'nightly' },
        };
        const redacted = redact(artefact, env);

        expect(JSON.stringify(redacted)).not.toContain('ghp_unit_user_token_value');
        expect(JSON.stringify(redacted)).not.toContain('apw-honeytoken-9f3c1d');
        expect(redacted.trace.requests[0].headers.authorization).toBe('Bearer [redacted]');
        expect(redacted.trace.console[0].text).toBe('planted [redacted] in the env entry');
        expect(redacted.env.APW_E2E_LANE, 'a non-secret value is untouched').toBe('nightly');
        expect(
            artefact.trace.console[0].text,
            'redaction returns a copy and leaves the artefact alone',
        ).toContain('apw-honeytoken-9f3c1d');
    });

    it('redacts a secret inside plain text and a multi-line kubeconfig', () => {
        const env = goodEnv();
        const kubeconfig =
            'apiVersion: v1\nusers:\n  - user:\n      token: kubeconfig-secret-value\n';
        env[APW_E2E.userClusterContext] = 'kind-apw-e2e';
        env['APW_E2E_USER_CLUSTER_KUBECONFIG'] = kubeconfig;

        const text = `GET /api/activity-log\nAuthorization: Bearer ${env[APW_E2E.githubUserToken]}\n${kubeconfig}`;
        const redacted = redact(text, env);
        expect(redacted).not.toContain('ghp_unit_user_token_value');
        expect(redacted).not.toContain('kubeconfig-secret-value');
        expect(redacted).toContain('[redacted]');
        expect(redacted).toContain('GET /api/activity-log');
    });

    it('reports the leaking variable by name, never its value', () => {
        const env = goodEnv();
        const artefact = { body: `the value is ${env[APW_E2E.githubEstateToken]}` };
        const leaks = findSecretLeaks(artefact, env);
        expect(leaks).toEqual([APW_E2E.githubEstateToken]);
        const error = catchError(() => assertNoSecretLeak(artefact, env));
        expect(error.message).toContain(APW_E2E.githubEstateToken);
        expect(error.message).not.toContain('ghp_unit_estate_token_value');
        expect(() => assertNoSecretLeak({ ok: true }, env)).not.toThrow();
    });
});

describe('app-works-live: spend accounting and the budget refusal (ACC-13-16)', () => {
    it('sums actionsMinutes and tokens over Run and Build receipts', () => {
        const spend = accountSpend([
            { kind: 'run', actionsMinutes: 4, tokens: 100_000 },
            { kind: 'build', actionsMinutes: 27, tokens: 212_345, checksBillableMinutes: 3 },
            { kind: 'run', billableMinutes: 6, tokens: 100_000 },
        ]);
        expect(spend).toEqual({ actionsMinutes: 37, tokens: 412_345 });
    });

    it('counts the checks matrix once, and only when it is reported separately', () => {
        expect(
            accountSpend([{ kind: 'build', billableMinutes: 10, checksBillableMinutes: 3 }]),
        ).toEqual({ actionsMinutes: 10, tokens: 0 });
        expect(accountSpend([{ kind: 'build', checksBillableMinutes: 3 }])).toEqual({
            actionsMinutes: 3,
            tokens: 0,
        });
    });

    it('refuses a receipt that is neither a Run nor a Build', () => {
        const releases = [{ kind: 'deploy' }] as unknown as RunReceipt[];
        expect(() => accountSpend(releases)).toThrow(/is neither a Run nor a Build receipt/);
    });

    it('formats the run summary spend line the spec fixes', () => {
        expect(
            formatSpendLine(
                { actionsMinutes: 47, tokens: 812_345 },
                { actionsMinutes: 225, tokens: 1_200_000 },
            ),
        ).toBe('Spend: 47 / 225 Actions minutes · 812345 / 1200000 tokens');
    });

    it('fails a token overrun with reason `budget`', () => {
        const budgets = { actionsMinutes: 225, tokens: 1_200_000 };
        const error = catchError(() =>
            assertWithinBudget({ actionsMinutes: 47, tokens: 1_200_001 }, budgets),
        );
        expect(error).toBeInstanceOf(BudgetExceededError);
        expect((error as BudgetExceededError).reason).toBe('budget');
        expect(error.message).toContain('reason: budget');
        expect((error as BudgetExceededError).spend.tokens).toBe(1_200_001);
    });

    it('fails an Actions-minutes overrun with reason `budget`, and passes a spend within budget', () => {
        const budgets = { actionsMinutes: 225, tokens: 1_200_000 };
        const error = catchError(() =>
            assertWithinBudget({ actionsMinutes: 226, tokens: 10 }, budgets),
        );
        expect((error as BudgetExceededError).reason).toBe('budget');
        expect(() =>
            assertWithinBudget({ actionsMinutes: 225, tokens: 1_200_000 }, budgets),
        ).not.toThrow();
    });

    it('reads the caps from the environment before enforcing them', () => {
        expect(budgetsFromEnv(goodEnv())).toEqual({ tokens: 1_200_000, actionsMinutes: 225 });
        expect(() => budgetsFromEnv({})).toThrow(/APW_E2E_TOKEN_BUDGET is not set/);
    });
});
