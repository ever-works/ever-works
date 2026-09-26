/**
 * App Works live-lane setup project (APW-13 P0 task T12,
 * `docs/specs/features/app-works/APW-13-golden-paths/tasks.md`; plan §8.1, §8.5,
 * §8.8).
 *
 * Runs **before any live scenario** and does five things, in this order:
 *
 *   1. **The seven interlocks of plan §8.5** (`assertLaneMayStart`). A lane that
 *      fails one never reaches a browser.
 *   2. **Registers the throwaway account** the run drives (plan §2.3, §9.6:
 *      "creates the throwaway account's Agent … before `fixture` starts").
 *   3. **Asserts the GitHub connection surface** (plan §8.8). This is the step
 *      that keeps the epic's promise: "`github-connection.ts` asserts the
 *      resulting state … before the first scenario and fails as S10/S19 naming
 *      the surface", so a lane without a connection fails *here*, by name, rather
 *      than at the first fork call as an unexplained 400.
 *   4. **Creates the account's Agent** with limited networking and its model
 *      credential (spec FR-65) and records the Agent id.
 *   5. **Writes the estate file** (plan §3.2) — the cleanup step's input.
 *
 * **T63 has landed surface (b)** (`POST /api/e2e/github-connection/seed` for the
 * PR lanes; the operator-run OAuth connect for the live lanes), so this step no
 * longer refuses with "no surface exists": it refuses only when the run account
 * has no connection at all, and then it names the two ways to get one plus the
 * surface the programme declined. The probe itself asks the platform's own
 * `GET /api/git-providers/github/connection` route
 * (`apps/api/src/plugins-capabilities/git-provider/git-provider.controller.ts:31`),
 * which reports `connected` plus `authMethod: 'oauth' | 'personal-access-token'`
 * — and a live lane must report `oauth`, because a `personal-access-token`
 * connection would be surface (a), which this programme decided against.
 * Nothing here fabricates a connection.
 */

import { expect, test as setup } from '@playwright/test';

import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import {
    type AppWorksEstate,
    assertLaneMayStart,
    emptyEstate,
    estateExists,
    runId,
    updateEstate,
    writeEstate,
} from './helpers/app-works-live';

/**
 * The surfaces plan §8.8 offers, as the platform reports them, with the one T63
 * landed marked as landed.
 *
 * T63 chose surface **(b)** — the non-production connection-seeding path — and
 * declined (a), the user-scope `x-secret accessToken` setting on the
 * `admin-only` GitHub plugin, because widening that boundary is the owner's call
 * rather than a lane's convenience. The `personal-access-token` entry stays
 * because the platform can still report it (an installation-level setting), and
 * a lane that found one would be relying on a surface this programme decided
 * against — so it is named, and refused, rather than silently accepted.
 */
const SURFACE_BY_AUTH_METHOD: Record<string, string> = {
    oauth:
        'a GitHub OAuth account row for the run account (plan §8.8 surface b — ' +
        'operator-connected for the live lanes, seeded through ' +
        'POST /api/e2e/github-connection/seed for the PR lanes)',
    'personal-access-token':
        'a user-scope GitHub access token setting (plan §8.8 surface a — NOT landed: ' +
        'T63 chose (b), because allowing that field would widen the admin-only plugin contract)',
};

interface ConnectionInfo {
    connected?: boolean;
    authMethod?: string;
    username?: string;
}

/**
 * Ask the platform whether the run account has a GitHub connection, and refuse
 * by name when it has none.
 */
async function assertGitHubConnection(
    request: import('@playwright/test').APIRequestContext,
    account: RegisteredUser,
): Promise<string> {
    const response = await request.get(`${API_BASE}/api/git-providers/github/connection`, {
        headers: authedHeaders(account.access_token),
    });
    expect(
        response.status(),
        `GET /api/git-providers/github/connection answered ${response.status()}: ${await response
            .text()
            .catch(() => '')}`,
    ).toBe(200);

    const info = (await response.json()) as ConnectionInfo;
    if (!info.connected) {
        throw new Error(
            'S10: no supported GitHub connection surface for this run account. ' +
                'T63 landed surface (b) of plan §8.8, so the surfaces that exist are: ' +
                `${SURFACE_BY_AUTH_METHOD.oauth} — the live lanes\' operator-run OAuth ` +
                "connect of the machine account, recorded in T20's estate file " +
                "(`docs/runbooks/app-works-acceptance-lanes.md`), and the PR lanes' seeding " +
                'route `POST /api/e2e/github-connection/seed`, which answers `404` unless ' +
                "`EVER_WORKS_E2E_FAKES=1` and `APW_E2E_GITHUB_FAKE_URL` are set in the API's " +
                'environment. This account has neither. Surface (a) — ' +
                `${SURFACE_BY_AUTH_METHOD['personal-access-token']} — is deliberately not ` +
                'available and is not a fallback. Refusing here rather than letting a scenario ' +
                'fail at its first fork call.',
        );
    }

    const surface = SURFACE_BY_AUTH_METHOD[info.authMethod ?? ''];
    if (!surface) {
        throw new Error(
            `S10: the platform reports a GitHub connection with authMethod '${info.authMethod}', ` +
                'which is not one of the surfaces plan §8.8 documents — record the new surface ' +
                'in CONTRACTS §7 and ACCEPTANCE §0.5 before a lane relies on it.',
        );
    }
    if (info.authMethod !== 'oauth') {
        throw new Error(
            `S10: the run account is connected by '${info.authMethod}', which is ${surface}. ` +
                'T63 landed surface (b), so a lane must not silently accept a connection that ' +
                'rests on the surface this programme decided against.',
        );
    }
    return surface;
}

setup(
    'app-works lane interlocks, the run account, its GitHub connection and its Agent',
    async ({ request }) => {
        // 1. The seven interlocks. Interlock 2's kube inputs come from the
        //    environment the lane sets; interlock 6 asserts which variable may carry
        //    a GitHub token at all, before anything attaches one.
        //
        //    Interlock 2 needs the context this lane will actually use, and the lane
        //    declares its contexts in the environment (plan §8.5). The user cluster
        //    is preferred and the apps tier is the fallback — which additionally
        //    demands the read-only kubeconfig, so the read-only rule is enforced
        //    here rather than discovered by the first cluster write. Passing nothing
        //    is not an option: `assertKubeContext` refuses an absent context, so a
        //    setup that omitted it could never reach the connection assertion below
        //    (S10) — which is half of T12's Done-when.
        const kubeContext =
            process.env.APW_E2E_USER_CLUSTER_CONTEXT ?? process.env.APW_E2E_APPS_TIER_CONTEXT;
        const id = runId();
        assertLaneMayStart({
            kube: {
                context: kubeContext,
                kubeconfigPath: process.env.APW_E2E_APPS_TIER_READ_KUBECONFIG,
            },
            proposalBaseOwner: process.env.APW_E2E_PROPOSAL_BASE_OWNER,
            upstreamOwner: process.env.APW_E2E_UPSTREAM_ORG,
            requestedGitHubTokenVariable: process.env.APW_E2E_GITHUB_TOKEN_VARIABLE,
            namespaces: [],
        });

        // 2. The throwaway account.
        const account = await registerUserViaAPI(request, { name: `apw-e2e ${id}` });

        // 3. The GitHub connection surface.
        const surface = await assertGitHubConnection(request, account);

        // 4. The account's Agent, with limited networking and its model credential
        //    (spec FR-65). The credential itself is a GitHub environment secret the
        //    lane provides; it is never written to the estate file — only the fact
        //    that the Agent carries one, and the Agent's id, are.
        const agent = await createAgentViaAPI(request, account.access_token, {
            name: `apw-e2e-${id}`,
        });

        // 5. The estate file. `updateEstate` merges into whatever is already on
        //    disk, so a setup re-run after a crashed scenario keeps that run's
        //    cleanup list instead of discarding it.
        const discovered: Partial<AppWorksEstate> = {
            runId: id,
            lane: process.env.APW_E2E_LANE,
            account: { email: account.email, userId: account.user.id },
            githubConnection: { surface, username: undefined },
            agentId: agent.id,
            webUrl: process.env.APW_E2E_WEB_URL ?? process.env.PLAYWRIGHT_BASE_URL,
            apiUrl: API_BASE,
        };
        if (estateExists()) {
            updateEstate(discovered);
            return;
        }
        writeEstate({ ...emptyEstate(id, process.env.APW_E2E_LANE), ...discovered });
    },
);
