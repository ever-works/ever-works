/**
 * The GitHub connection surface a lane attaches to its run account
 * (APW-13 T63; plan §8.2 — `plan.md:504` — and §8.8 surface **(b)** —
 * `plan.md:661`).
 *
 * ## What this helper is for (FR-56, S10)
 *
 * Every create, fork and link scenario needs the run account to hold a Git
 * credential, and the platform has exactly one reachable place to keep one: an
 * OAuth account row (`git.facade.ts` reads the token from an account row or from
 * a plugin setting, and the GitHub plugin is `admin-only` with no `accessToken`
 * field, so only the account row is reachable). `connectCustomerGitHub` is the
 * one call a scenario makes to get there, and it **asserts the resulting
 * platform state** before the scenario runs — so a lane without a connection
 * fails here, by name, rather than as an unexplained `400` deep inside a fork
 * step.
 *
 * ## The decision this lands, and why (T63)
 *
 * `tasks.md:723-737` offers two surfaces and the programme chose **(b)** — the
 * non-production connection-seeding path — over (a), the user-scope
 * `x-secret accessToken` setting on the `admin-only` GitHub plugin. (a) widens a
 * security boundary the plugin still refuses today
 * (`plugin-operations.service.ts` throws for user- and work-scope settings on an
 * admin-only plugin), and that widening is the owner's call rather than a lane's
 * convenience. Surface (b) changes no plugin contract:
 *
 *   - **PR lanes** seed a fake-GitHub account row through
 *     `POST /api/e2e/github-connection/seed`, which cannot exist in production —
 *     it answers `404` unless `NODE_ENV !== 'production'` **and**
 *     `EVER_WORKS_E2E_FAKES === '1'` **and** `APW_E2E_GITHUB_FAKE_URL` is set
 *     (`apps/api/src/plugins-capabilities/git-provider/e2e-github-connection-seed.controller.ts`,
 *     the same posture as APW-11 T33's `POST /api/e2e/app-launcher/seed`);
 *   - **live lanes** reuse the **operator-run OAuth connect** of the machine
 *     account, recorded in T20's estate file — this helper then finds the row
 *     already there and never seeds anything.
 *
 * The decision is recorded in CONTRACTS §7 (the `EVER_WORKS_E2E_FAKES` /
 * `APW_E2E_GITHUB_FAKE_URL` rows) and in ACCEPTANCE §0.5.
 *
 * ## The two properties the unit spec pins
 *
 *   1. **Each surface asserts the state it claims.** A successful call always
 *      ends with a **re-read** of the platform's own
 *      `GET /api/git-providers/github/connection`, and a read that disagrees
 *      with the write is a refusal naming the state the platform did not return.
 *   2. **A refused surface fails with its name, and never as a raw `400`.** The
 *      route's `404` (not armed, or production), its `401`, its `400` (a body
 *      outside the fixture shape) and an unreachable API each produce an `S10:`
 *      message that names the surface — so a reader is never left decoding a
 *      status code.
 */

import { type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';
import { platformGitHubToken, PLATFORM_GITHUB_TOKEN_VARIABLE } from './app-works-live';

// ---------------------------------------------------------------------------
// The routes and the surfaces, spelled once
// ---------------------------------------------------------------------------

/** The read route — the platform's own answer to "is this account connected?". */
export const GITHUB_CONNECTION_READ_PATH = '/api/git-providers/github/connection';

/** The non-production seeding route (plan §8.8 surface (b)). */
export const GITHUB_CONNECTION_SEED_PATH = '/api/e2e/github-connection/seed';

/** The provider both routes are about. */
export const GITHUB_CONNECTION_PROVIDER_ID = 'github';

/** The switch the seeding route reads (CONTRACTS §7, APW-13 T5). */
export const GITHUB_FAKES_SWITCH_ENV = 'EVER_WORKS_E2E_FAKES';

/** The fake origin the seeding route reads, and the plugin builds its URLs from. */
export const GITHUB_FAKE_URL_ENV = 'APW_E2E_GITHUB_FAKE_URL';

/**
 * The PR lane's fake identity, as the checked-in seed fixture registers it
 * (`apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json`).
 *
 * It is a deliberately non-token-shaped literal (the fixture README says so),
 * not a credential: the fake maps it to the login `apw-e2e-user`, which is what
 * makes the fake attribute the lane's fork, clone and push calls to that login.
 * It lives here, on the harness side, and never in the product — the fake is
 * test infrastructure the platform never loads (plan §13).
 */
export const FAKE_GITHUB_LANE_LOGIN = 'apw-e2e-user';
export const FAKE_GITHUB_LANE_TOKEN = 'apw-e2e-user-token';

/** Which surface a lane's connection came from. */
export type GitHubConnectionSurfaceId = 'oauth-account' | 'seeded-fake-oauth-account';

/** The human name of each surface, so a refusal names one instead of a status. */
export const GITHUB_CONNECTION_SURFACE_LABELS: Record<GitHubConnectionSurfaceId, string> = {
    'oauth-account':
        'the operator-run GitHub OAuth connect of the run account (plan §8.8 surface b, the live lanes)',
    'seeded-fake-oauth-account':
        'the seeded fake-GitHub OAuth account row (plan §8.8 surface b: POST ' +
        `${GITHUB_CONNECTION_SEED_PATH}, non-production only)`,
};

/** What the platform reports for a connection, plus the surface it is. */
export interface GitHubConnectionState {
    providerId: string;
    connected: true;
    /** `oauth` for both surfaces (b) offers; a setting would report a PAT. */
    authMethod: string;
    username?: string;
    surfaceId: GitHubConnectionSurfaceId;
    /** The same fact, in words, for the estate file and a failure message. */
    surface: string;
}

/** The platform's answer, as `GET …/connection` returns it. */
export interface GitHubConnectionRead {
    connected?: boolean;
    authMethod?: string;
    username?: string;
    email?: string;
    id?: string;
}

// ---------------------------------------------------------------------------
// The token the platform may be given
// ---------------------------------------------------------------------------

/**
 * The Git token a lane attaches, resolved in the lane's own order.
 *
 *   1. **`APW_E2E_GITHUB_USER_TOKEN`** when the lane sets it — the live lane's
 *      customer token, and the only variable interlock 6 permits. It is read
 *      through `platformGitHubToken`, so the estate credential is still refused
 *      by name and an estate/user collision is still refused.
 *   2. **The fake's seeded identity** when `EVER_WORKS_E2E_FAKES === '1'` — the
 *      PR lane, whose fixture gives every fake user a token and whose plugin is
 *      pointed at the fake. The lane does not set
 *      `APW_E2E_GITHUB_USER_TOKEN` today (the live lanes do), and requiring it
 *      would make the PR lane fail for a variable that means "the customer's
 *      real token" everywhere else in this harness.
 *   3. **Refused**, by name, otherwise — never a silent empty token.
 */
export function laneGitHubToken(env: NodeJS.ProcessEnv = process.env): string {
    const declared = (env[PLATFORM_GITHUB_TOKEN_VARIABLE] ?? '').trim();
    if (declared.length > 0) {
        // Delegated rather than re-implemented: interlock 6's two refusals are
        // the harness's rule for who may hold a platform-facing token.
        return platformGitHubToken(env);
    }
    if ((env[GITHUB_FAKES_SWITCH_ENV] ?? '').trim() === '1') {
        return FAKE_GITHUB_LANE_TOKEN;
    }
    throw new Error(
        `S10: no GitHub token for this lane. ${PLATFORM_GITHUB_TOKEN_VARIABLE} is not set and ` +
            `${GITHUB_FAKES_SWITCH_ENV} is not '1', so neither surface of plan §8.8 can be ` +
            'attached: the live lanes set ' +
            `${PLATFORM_GITHUB_TOKEN_VARIABLE}, and the PR lane arms the fake GitHub with ` +
            `${GITHUB_FAKES_SWITCH_ENV}=1 and ${GITHUB_FAKE_URL_ENV}.`,
    );
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Ask the platform whether the run account has a GitHub connection.
 *
 * A non-`200` answer is a refusal naming this route — never a bare
 * `expect(status).toBe(200)` that reports "expected 200, received 500" and
 * leaves the reader to guess which surface is missing.
 */
export async function readGitHubConnection(
    request: APIRequestContext,
    token: string,
): Promise<GitHubConnectionRead> {
    const response = await request.get(`${API_BASE}${GITHUB_CONNECTION_READ_PATH}`, {
        headers: authedHeaders(token),
        failOnStatusCode: false,
    });
    const text = await response.text().catch(() => '');
    if (response.status() !== 200) {
        throw new Error(
            `S10: the platform could not answer ${GITHUB_CONNECTION_READ_PATH} ` +
                `(HTTP ${response.status()}): ${text.slice(0, 300)}. The read route is what every ` +
                "scenario's Git call depends on, so this is a lane failure, not a scenario " +
                'failure.',
        );
    }
    try {
        return JSON.parse(text) as GitHubConnectionRead;
    } catch {
        throw new Error(
            `S10: ${GITHUB_CONNECTION_READ_PATH} answered 200 with a body that is not JSON ` +
                `(${text.slice(0, 200)})`,
        );
    }
}

/**
 * The **state assertion** of plan §8.2: turn the platform's read into the
 * surface claim, or refuse by name.
 *
 * A connection by OAuth account row is surface (b) — whichever way the row
 * arrived (seeded in a PR lane, operator-connected in a live lane). Anything
 * else is refused with what the platform actually reported, because surface (a)
 * — a user-scope `accessToken` setting — is deliberately **not** landed
 * (T63's decision), so a lane must not quietly accept it as one of its own.
 */
export function assertGitHubConnectionState(
    read: GitHubConnectionRead,
    surfaceId: GitHubConnectionSurfaceId = 'oauth-account',
): GitHubConnectionState {
    if (read?.connected !== true) {
        throw new Error(
            `S10: no supported GitHub connection surface for this run account. The platform ` +
                `reports connected=${JSON.stringify(read?.connected ?? null)} ` +
                `(authMethod=${JSON.stringify(read?.authMethod ?? null)}). Plan §8.8 offers two ` +
                'surfaces and T63 landed (b): the non-production seeding route ' +
                `${GITHUB_CONNECTION_SEED_PATH} for the PR lanes, and the operator-run OAuth ` +
                'connect of the machine account for the live lanes. Surface (a) — a user-scope ' +
                'GitHub access token setting — was declined, so it is not a fallback.',
        );
    }

    if (read.authMethod !== 'oauth') {
        throw new Error(
            `S10: the platform reports a GitHub connection with authMethod ` +
                `${JSON.stringify(read.authMethod ?? null)}, which is not the surface T63 landed ` +
                `(${GITHUB_CONNECTION_SURFACE_LABELS['oauth-account']}). A ` +
                "'personal-access-token' answer means an installation-level setting is carrying " +
                'the token — surface (a), which this programme decided against. Record any new ' +
                'surface in CONTRACTS §7 and ACCEPTANCE §0.5 before a lane relies on it.',
        );
    }

    return {
        providerId: read.id ?? GITHUB_CONNECTION_PROVIDER_ID,
        connected: true,
        authMethod: 'oauth',
        username: read.username,
        surfaceId,
        surface: GITHUB_CONNECTION_SURFACE_LABELS[surfaceId],
    };
}

// ---------------------------------------------------------------------------
// The connect
// ---------------------------------------------------------------------------

/** What a caller may override when attaching the lane's connection. */
export interface ConnectCustomerGitHubOptions {
    /** The Git token to attach; defaults to {@link laneGitHubToken}. */
    accessToken?: string;
    /** The login to record; defaults to the fake's login in a fake lane. */
    username?: string;
    /** The granted scopes; the route defaults to `repo`, which a fork needs. */
    scope?: string;
}

/**
 * The route's refusal, as a value — so the two failure classes can be told
 * apart: "the surface is closed" (404) versus "the surface refused the fixture"
 * (400/401/other).
 */
interface SeedAttempt {
    status: number;
    text: string;
}

async function attemptSeed(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<SeedAttempt> {
    try {
        const response = await request.post(`${API_BASE}${GITHUB_CONNECTION_SEED_PATH}`, {
            headers: authedHeaders(token),
            data: body,
            failOnStatusCode: false,
        });
        return { status: response.status(), text: await response.text().catch(() => '') };
    } catch (error) {
        return { status: 0, text: error instanceof Error ? error.message : String(error) };
    }
}

/** The refusal for an attempt whose status is not 201/404/401 — always named. */
function refusalForStatus(attempt: SeedAttempt, surface: string): Error {
    return new Error(
        `S10: ${surface} refused the fixture — POST ${GITHUB_CONNECTION_SEED_PATH} answered ` +
            `HTTP ${attempt.status}: ${attempt.text.slice(0, 300)}. This is the surface refusing ` +
            "the lane's own body (a token outside the closed shape, a scope the DTO will not " +
            'accept), not a platform refusal of a scenario, and it is deliberately reported by ' +
            "the surface's name rather than as a raw status assertion.",
    );
}

/**
 * Attach the run account's GitHub connection through the landed surface, and
 * assert the resulting platform state before any scenario runs (plan §8.2).
 *
 * The order is deliberate:
 *
 *   1. **Read first.** A live lane's operator-run OAuth row is already there, and
 *      the helper must never try to seed over a real connection.
 *   2. **Seed only when there is none.** The seeding route is the PR lanes'
 *      surface, and it is closed (`404`) in every live lane and in production —
 *      which is what makes "the lane never falls back to a surface the platform
 *      refuses" a property of the code rather than of the operator.
 *   3. **Re-read and assert.** A `201` is not evidence that the platform now
 *      reports a connection: the read route resolves the provider through the
 *      plugin registry and calls the provider, so the two can disagree, and a
 *      disagreement is reported as the state the platform did not return.
 */
export async function connectCustomerGitHub(
    request: APIRequestContext,
    token: string,
    options: ConnectCustomerGitHubOptions = {},
): Promise<GitHubConnectionState> {
    const before = await readGitHubConnection(request, token);
    if (before.connected === true) {
        return assertGitHubConnectionState(before, 'oauth-account');
    }

    const fakeLane = (process.env[GITHUB_FAKES_SWITCH_ENV] ?? '').trim() === '1';
    const accessToken = options.accessToken ?? laneGitHubToken();
    const username = options.username ?? (fakeLane ? FAKE_GITHUB_LANE_LOGIN : undefined);
    const body: Record<string, unknown> = { accessToken };
    if (username !== undefined) body.username = username;
    if (options.scope !== undefined) body.scope = options.scope;

    const seededSurface = GITHUB_CONNECTION_SURFACE_LABELS['seeded-fake-oauth-account'];
    const attempt = await attemptSeed(request, token, body);

    if (attempt.status === 404) {
        throw new Error(
            `S10: no supported GitHub connection surface for this run account. The account has ` +
                `no GitHub OAuth row, and the non-production seeding route ` +
                `POST ${GITHUB_CONNECTION_SEED_PATH} answered 404 — it is not mounted on this ` +
                `API, which is what a production process and an unarmed lane look like. It ` +
                `requires ${GITHUB_FAKES_SWITCH_ENV}='1' and ${GITHUB_FAKE_URL_ENV} in the API's ` +
                "environment (CONTRACTS §7). The live lanes' alternative is the operator-run " +
                'OAuth connect of the machine account, recorded in the estate file.',
        );
    }

    if (attempt.status === 401) {
        throw new Error(
            `S10: ${seededSurface} refused the run account's session — POST ` +
                `${GITHUB_CONNECTION_SEED_PATH} answered 401: ${attempt.text.slice(0, 200)}. ` +
                'The route writes for the signed-in person only, so a token the API does not ' +
                'accept cannot attach a connection.',
        );
    }

    if (attempt.status !== 201) {
        throw refusalForStatus(attempt, seededSurface);
    }

    const after = await readGitHubConnection(request, token);
    const state = assertGitHubConnectionState(after, 'seeded-fake-oauth-account');
    if (username !== undefined && state.username !== username) {
        // The fixture named a login and the platform's read did not report it:
        // the two disagree about the connection the scenario is about to use, so
        // the lane reports the state the platform returns, never the state the
        // fixture intended.
        throw new Error(
            `S10: the seeded connection named login ${JSON.stringify(username)} and ` +
                `${GITHUB_CONNECTION_READ_PATH} reported ` +
                `${JSON.stringify(state.username ?? null)}. The seeded token is not the identity ` +
                "the lane thinks it is — check the fake GitHub's seed fixture " +
                '(catalog-pr-lane.seed.json) against the token this lane attached.',
        );
    }
    return state;
}
