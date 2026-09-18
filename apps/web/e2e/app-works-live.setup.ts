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
 *      the surface", so a lane without a connection fails *here*, by name,
 *      rather than at the first fork call as an unexplained 400.
 *   4. **Creates the account's Agent** with limited networking and its model
 *      credential (spec FR-65) and records the Agent id.
 *   5. **Writes the estate file** (plan §3.2) — the cleanup step's input.
 *
 * **Until T63 lands there is no supported connection surface**, so step 3 fails
 * with `S10` naming both documented surfaces and T63. That is the intended P0
 * behaviour, not a stub: T14/T15/T16/T30/T31 carry
 * `test.fixme('APW-13 T63: no supported GitHub connection surface')` for exactly
 * this reason (plan §8.8, `plan.md:666-667`), and this project is what turns
 * "the surface is missing" into one named failure instead of five confusing
 * ones. The probe itself is real — it asks the platform's own
 * `GET /api/git-providers/github/connection` route
 * (`apps/api/src/plugins-capabilities/git-provider/git-provider.controller.ts:32`),
 * which reports `connected` plus `authMethod: 'oauth' | 'personal-access-token'`
 * — the two surfaces §8.8 names. Nothing here fabricates a connection.
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

/** The surfaces plan §8.8 offers, as the platform reports them. */
const SURFACE_BY_AUTH_METHOD: Record<string, string> = {
    oauth: 'a GitHub OAuth account row for the run account (plan §8.8 surface b)',
    'personal-access-token': 'a user-scope GitHub access token setting (plan §8.8 surface a)',
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
                'APW-13 T63 has not landed, so neither surface of plan §8.8 exists yet: ' +
                `${SURFACE_BY_AUTH_METHOD.oauth}, or ${SURFACE_BY_AUTH_METHOD['personal-access-token']}. ` +
                'Every create, fork and link scenario (T14, T15, T16, T30, T31) carries ' +
                "test.fixme('APW-13 T63: no supported GitHub connection surface') until it does " +
                '(plan.md §8.8). Refusing here rather than letting a scenario fail at its first fork call.',
        );
    }

    const surface = SURFACE_BY_AUTH_METHOD[info.authMethod ?? ''];
    if (!surface) {
        throw new Error(
            `S10: the platform reports a GitHub connection with authMethod '${info.authMethod}', ` +
                'which is not one of the two surfaces plan §8.8 documents — record the new surface ' +
                'in CONTRACTS and ACCEPTANCE §0.5 before a lane relies on it.',
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
        const id = runId();
        assertLaneMayStart({
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
