/**
 * Unit spec for the GitHub connection helper (APW-13 T63, `tasks.md:723-737`).
 *
 * T63's own Test line asks for three things of this file, plus the surface
 * assertions:
 *
 *   1. **Each surface asserts the state it claims.** Both is proved here — the
 *      live lane's pre-existing OAuth row, and the PR lane's seeded fake row —
 *      including what happens when the platform's re-read **disagrees** with the
 *      write, which is the failure a write-only helper could never see.
 *   2. **A refused surface fails with its name and no raw `400`.** Every
 *      refusal path is driven (closed route, bad body, refused session,
 *      unreachable read) and each message must name the surface and read as a
 *      refusal rather than as `expected 201, received 400`.
 *   3. **The surface the helper talks to is the one the API serves.** The API
 *      route is pinned from this side by reading the controller's own source:
 *      the path, the two gate variables and the production refusal must all
 *      still be there, so a rename on either side reddens this spec.
 *
 * Surface (a) — the user-scope `accessToken` setting — is asserted to be
 * **refused**: T63 chose (b), and a helper that silently accepted a PAT
 * connection would be relying on a surface the programme declined to land.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assertGitHubConnectionState,
    connectCustomerGitHub,
    FAKE_GITHUB_LANE_LOGIN,
    FAKE_GITHUB_LANE_TOKEN,
    GITHUB_CONNECTION_READ_PATH,
    GITHUB_CONNECTION_SEED_PATH,
    GITHUB_CONNECTION_SURFACE_LABELS,
    laneGitHubToken,
    readGitHubConnection,
} from '../github-connection';

// ---------------------------------------------------------------------------
// The stubbed API
// ---------------------------------------------------------------------------

interface StubCall {
    method: string;
    url: string;
    headers: Record<string, string>;
    data: unknown;
}

interface Reply {
    status: number;
    body?: unknown;
    /** Overrides the JSON body with raw text (a non-JSON answer). */
    text?: string;
}

type Responder = (call: StubCall, index: number) => Reply;

/**
 * A scripted `APIRequestContext`: replies are consumed in call order, and every
 * call is recorded so a spec can assert *whether* the seed was attempted.
 */
function scriptedRequest(script: Responder | Reply[]): {
    request: APIRequestContext;
    calls: StubCall[];
} {
    const calls: StubCall[] = [];
    const request = {
        get: async (url: string, options: Record<string, unknown> = {}) =>
            respond({
                method: 'GET',
                url,
                headers: (options.headers ?? {}) as Record<string, string>,
                data: options.data,
            }),
        post: async (url: string, options: Record<string, unknown> = {}) =>
            respond({
                method: 'POST',
                url,
                headers: (options.headers ?? {}) as Record<string, string>,
                data: options.data,
            }),
        fetch: async (url: string, options: Record<string, unknown> = {}) =>
            respond({
                method: String(options.method ?? 'GET'),
                url,
                headers: (options.headers ?? {}) as Record<string, string>,
                data: options.data,
            }),
    } as unknown as APIRequestContext;

    function respond(call: StubCall): APIResponse {
        const index = calls.length;
        calls.push(call);
        const reply =
            typeof script === 'function' ? script(call, index) : (script[index] ?? { status: 500 });
        const text = reply.text ?? JSON.stringify(reply.body ?? {});
        return {
            status: () => reply.status,
            ok: () => reply.status >= 200 && reply.status < 300,
            text: async () => text,
            json: async () => JSON.parse(text),
        } as unknown as APIResponse;
    }

    return { request, calls };
}

/** The platform's read answer for a connected account. */
function connectedRead(overrides: Record<string, unknown> = {}): Reply {
    return {
        status: 200,
        body: {
            id: 'github',
            name: 'GitHub',
            enabled: true,
            connected: true,
            authMethod: 'oauth',
            username: FAKE_GITHUB_LANE_LOGIN,
            ...overrides,
        },
    };
}

/** The platform's read answer for an account with no connection. */
const UNCONNECTED: Reply = {
    status: 200,
    body: { id: 'github', name: 'GitHub', enabled: true, connected: false },
};

const SESSION_TOKEN = 'session-token-of-the-run-account';

/** Every variable this spec touches. */
const ENV_KEYS = [
    'EVER_WORKS_E2E_FAKES',
    'APW_E2E_GITHUB_FAKE_URL',
    'APW_E2E_GITHUB_USER_TOKEN',
    'APW_E2E_GITHUB_ESTATE_TOKEN',
] as const;

const envBackup: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) envBackup[key] = process.env[key];

/** The PR lane's environment, as `.github/workflows/e2e.yml` arms it. */
function armFakeLane(): void {
    process.env.EVER_WORKS_E2E_FAKES = '1';
    process.env.APW_E2E_GITHUB_FAKE_URL = 'http://127.0.0.1:3900';
    delete process.env.APW_E2E_GITHUB_USER_TOKEN;
    delete process.env.APW_E2E_GITHUB_ESTATE_TOKEN;
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (envBackup[key] === undefined) delete process.env[key];
        else process.env[key] = envBackup[key];
    }
});

// ---------------------------------------------------------------------------
// 1. Each surface asserts the state it claims
// ---------------------------------------------------------------------------

describe('connectCustomerGitHub: the live lane’s operator-run OAuth row (surface b)', () => {
    it('accepts a connection that is already there and seeds nothing', async () => {
        const { request, calls } = scriptedRequest([connectedRead()]);

        const state = await connectCustomerGitHub(request, SESSION_TOKEN);

        expect(state).toEqual({
            providerId: 'github',
            connected: true,
            authMethod: 'oauth',
            username: FAKE_GITHUB_LANE_LOGIN,
            surfaceId: 'oauth-account',
            surface: GITHUB_CONNECTION_SURFACE_LABELS['oauth-account'],
        });
        // Read only: an existing real connection is never written over.
        expect(calls.map((call) => call.method)).toEqual(['GET']);
        expect(calls[0].url).toContain(GITHUB_CONNECTION_READ_PATH);
        expect(calls[0].headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    });

    it('refuses a personal-access-token connection by name — surface (a) is not landed', async () => {
        const { request } = scriptedRequest([
            connectedRead({ authMethod: 'personal-access-token' }),
        ]);

        await expect(connectCustomerGitHub(request, SESSION_TOKEN)).rejects.toThrow(
            /S10: the platform reports a GitHub connection with authMethod "personal-access-token"/,
        );
    });
});

describe('connectCustomerGitHub: the PR lane’s seeded fake row (surface b)', () => {
    it('seeds, then asserts the platform’s own re-read', async () => {
        armFakeLane();
        const { request, calls } = scriptedRequest([
            UNCONNECTED,
            { status: 201, body: {} },
            connectedRead(),
        ]);

        const state = await connectCustomerGitHub(request, SESSION_TOKEN);

        expect(state.surfaceId).toBe('seeded-fake-oauth-account');
        expect(state.surface).toBe(GITHUB_CONNECTION_SURFACE_LABELS['seeded-fake-oauth-account']);
        expect(state.authMethod).toBe('oauth');
        expect(state.username).toBe(FAKE_GITHUB_LANE_LOGIN);

        // Read → seed → read. The third call is what makes "the state it claims"
        // a fact about the platform rather than about the write's 201.
        expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
        expect(calls[1].url).toContain(GITHUB_CONNECTION_SEED_PATH);
        expect(calls[1].headers.Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
        expect(calls[1].data).toEqual({
            accessToken: FAKE_GITHUB_LANE_TOKEN,
            username: FAKE_GITHUB_LANE_LOGIN,
        });
    });

    it('passes an explicit token, login and scope through untouched', async () => {
        armFakeLane();
        const { request, calls } = scriptedRequest([
            UNCONNECTED,
            { status: 201, body: {} },
            connectedRead({ username: 'apw-e2e-reviewer' }),
        ]);

        await connectCustomerGitHub(request, SESSION_TOKEN, {
            accessToken: 'apw-e2e-reviewer-token',
            username: 'apw-e2e-reviewer',
            scope: 'repo read:org',
        });

        expect(calls[1].data).toEqual({
            accessToken: 'apw-e2e-reviewer-token',
            username: 'apw-e2e-reviewer',
            scope: 'repo read:org',
        });
    });

    it('refuses when the platform’s re-read does not report the connection the write claimed', async () => {
        armFakeLane();
        const { request } = scriptedRequest([UNCONNECTED, { status: 201, body: {} }, UNCONNECTED]);

        await expect(connectCustomerGitHub(request, SESSION_TOKEN)).rejects.toThrow(
            /S10: no supported GitHub connection surface for this run account/,
        );
    });

    it('refuses when the re-read reports a login the fixture did not name', async () => {
        armFakeLane();
        const { request } = scriptedRequest([
            UNCONNECTED,
            { status: 201, body: {} },
            connectedRead({ username: 'unknown' }),
        ]);

        await expect(connectCustomerGitHub(request, SESSION_TOKEN)).rejects.toThrow(
            /S10: the seeded connection named login "apw-e2e-user"/,
        );
    });
});

// ---------------------------------------------------------------------------
// 2. A refused surface fails with its name, and never as a raw 400
// ---------------------------------------------------------------------------

/** The refusal classes, each with the surface name its message must carry. */
const REFUSALS: Array<{ label: string; script: Reply[]; named: RegExp }> = [
    {
        label: 'the seeding route is not mounted (production, or the lane is unarmed)',
        script: [UNCONNECTED, { status: 404, body: { message: 'Cannot find route' } }],
        named: /POST \/api\/e2e\/github-connection\/seed answered 404/,
    },
    {
        label: 'the seeding route refused the fixture body',
        script: [
            UNCONNECTED,
            { status: 400, body: { message: ['accessToken should not be empty'] } },
        ],
        named: /plan §8\.8 surface b[\s\S]*refused the fixture/,
    },
    {
        label: 'the seeding route refused the session',
        script: [UNCONNECTED, { status: 401, body: { message: 'Unauthorized' } }],
        named: /refused the run account's session/,
    },
    {
        label: 'the API was unreachable',
        script: [UNCONNECTED, { status: 0, text: 'connect ECONNREFUSED 127.0.0.1:3100' }],
        named: /refused the fixture[\s\S]*ECONNREFUSED/,
    },
];

describe('a refused surface fails with its name, never as a raw 400 (FR-56, S10)', () => {
    it.each(REFUSALS)('$label', async ({ script, named }) => {
        armFakeLane();
        const { request } = scriptedRequest(script);

        const error = await connectCustomerGitHub(request, SESSION_TOKEN).catch(
            (thrown: unknown) => thrown as Error,
        );

        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        // It names the surface...
        expect(message).toMatch(/S10: /);
        expect(message).toMatch(named);
        // ...and it is not a status assertion leaking through as the failure.
        expect(message).not.toMatch(/expected \d{3}/i);
        expect(message).not.toMatch(/received \d{3}/i);
    });

    it('reads the surface off the read route rather than assuming it', async () => {
        const { request } = scriptedRequest([
            { status: 500, body: { message: 'Internal server error' } },
        ]);

        const error = await readGitHubConnection(request, SESSION_TOKEN).catch(
            (thrown: unknown) => thrown as Error,
        );

        expect((error as Error).message).toContain(
            `S10: the platform could not answer ${GITHUB_CONNECTION_READ_PATH} (HTTP 500)`,
        );
        expect((error as Error).message).not.toMatch(/expected 200/i);
    });

    it('names the read route when it answers 200 with a body that is not JSON', async () => {
        const { request } = scriptedRequest([{ status: 200, text: '<html>login</html>' }]);

        await expect(readGitHubConnection(request, SESSION_TOKEN)).rejects.toThrow(
            /answered 200 with a body that is not JSON/,
        );
    });

    it('refuses a state the platform did not claim, from the pure assertion alone', () => {
        expect(() => assertGitHubConnectionState({ connected: false })).toThrow(
            /S10: no supported GitHub connection surface for this run account/,
        );
        expect(() =>
            assertGitHubConnectionState({ connected: true, authMethod: undefined }),
        ).toThrow(/S10: the platform reports a GitHub connection with authMethod null/);
    });
});

// ---------------------------------------------------------------------------
// 3. The token the platform may be given
// ---------------------------------------------------------------------------

describe('laneGitHubToken: the lane’s own order', () => {
    it('prefers APW_E2E_GITHUB_USER_TOKEN when the lane sets it', () => {
        armFakeLane();
        process.env.APW_E2E_GITHUB_USER_TOKEN = 'ghp_the_live_lane_token';

        expect(laneGitHubToken()).toBe('ghp_the_live_lane_token');
    });

    it('refuses the estate credential by name, even in a fake lane', () => {
        armFakeLane();
        process.env.APW_E2E_GITHUB_ESTATE_TOKEN = 'ghp_estate';
        process.env.APW_E2E_GITHUB_USER_TOKEN = 'ghp_estate';

        expect(() => laneGitHubToken()).toThrow(
            /the value offered to the platform is the harness estate credential/,
        );
    });

    it('uses the fake’s seeded identity in a fake lane, and only there', () => {
        armFakeLane();
        expect(laneGitHubToken()).toBe(FAKE_GITHUB_LANE_TOKEN);

        process.env.EVER_WORKS_E2E_FAKES = 'true';
        expect(() => laneGitHubToken()).toThrow(
            /S10: no GitHub token for this lane\. APW_E2E_GITHUB_USER_TOKEN is not set/,
        );
    });
});

// ---------------------------------------------------------------------------
// 4. The surface the helper talks to is the one the API serves
// ---------------------------------------------------------------------------

describe('the helper and the API route agree (T63)', () => {
    /** The controller this helper is written against, read from the API tree. */
    const CONTROLLER_PATH = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../api/src/plugins-capabilities/git-provider/e2e-github-connection-seed.controller.ts',
    );

    const source = readFileSync(CONTROLLER_PATH, 'utf8');

    it('reads a real controller (the control for every assertion below)', () => {
        expect(source.length).toBeGreaterThan(1_000);
        expect(source).toContain('class E2eGitHubConnectionSeedController');
    });

    it('serves exactly the path this helper posts to', () => {
        expect(source).toContain(`@Controller('api/e2e/github-connection/seed')`);
        expect(GITHUB_CONNECTION_SEED_PATH).toBe('/api/e2e/github-connection/seed');
    });

    it('gates on the two variables this helper and the lane arm', () => {
        expect(source).toContain("E2E_CONNECTION_SEED_FAKES_ENV = 'EVER_WORKS_E2E_FAKES'");
        expect(source).toContain("E2E_CONNECTION_SEED_FAKE_URL_ENV = 'APW_E2E_GITHUB_FAKE_URL'");
        expect(source).toContain("process.env.NODE_ENV === 'production'");
        // The posture, not just the variables: the refusal is opaque.
        expect(source).toContain("new NotFoundException('Cannot find route')");
    });

    it('is registered only when the gate is open at boot', () => {
        const modulePath = resolve(
            dirname(fileURLToPath(import.meta.url)),
            '../../../../api/src/plugins-capabilities/git-provider/git-provider.module.ts',
        );
        const moduleSource = readFileSync(modulePath, 'utf8');

        expect(moduleSource).toContain('if (isE2eGitHubConnectionSeedEnabled())');
        expect(moduleSource).toContain('CONTROLLERS.push(E2eGitHubConnectionSeedController)');
    });

    it('declares the read route this helper reads', () => {
        const readControllerPath = resolve(
            dirname(fileURLToPath(import.meta.url)),
            '../../../../api/src/plugins-capabilities/git-provider/git-provider.controller.ts',
        );
        const readSource = readFileSync(readControllerPath, 'utf8');

        expect(readSource).toContain("@Controller('api/git-providers')");
        expect(readSource).toContain("@Get(':providerId/connection')");
        expect(GITHUB_CONNECTION_READ_PATH).toBe('/api/git-providers/github/connection');
    });
});
