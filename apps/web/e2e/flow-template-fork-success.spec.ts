/**
 * APW-13 T15 — Work Template fork succeeds (ACC-REG-02).
 *
 * ACC-REG-02's recorded verdict is *Gap — no successful fork anywhere; no
 * GitHub plugin test of the fork call*. The fork path needs the caller's GitHub
 * connection twice over: the platform forks INTO an owner the caller can write
 * to, and it clones the result with the CALLER'S token, which is the fact this
 * spec is supposed to pin (`GET /_control/calls` on the fake must show that
 * token on the fork call — T15's own "Done when").
 *
 * ── Why the success half cannot run yet (APW-13 plan §8.8, T63):
 *
 * `git.facade.ts` reads the Git token from an OAuth account row or from a plugin
 * SETTING. The GitHub plugin is `configurationMode: 'admin-only'`
 * (`packages/plugins/github/src/github.plugin.ts`) with no `accessToken` field
 * in its `settingsSchema`, and `plugin-operations.service.ts` throws
 * `ForbiddenException` for user-scope settings on an admin-only plugin — so a
 * lane account has no supported way to hold a token. Until T63 lands one of the
 * two surfaces, every fork scenario is unreachable, and this spec carries the
 * shared marker rather than a silent skip.
 *
 * ── What DOES run here, on the live stack:
 *
 * The fork SURFACE is asserted to be closed, over HTTP, in the same place the
 * assertions will be read from once T63 opens it:
 *
 *   • `POST /api/works` with the app fork fields is refused by the validation
 *     pipe (`property repositoryMode should not exist` — the DTO half of
 *     APW-01/APW-02 has not landed in this tree), so no fork can be requested
 *     through the create route at all;
 *   • the fake GitHub records no fork call, so nothing forked behind the
 *     refusal.
 *
 * That is the honest, runnable half of "the fork does not happen"; the positive
 * half — fork into the user, fork into an organization, and the fake's record of
 * the user's token — is the fixme'd test below.
 *
 * Verified live against http://127.0.0.1:3100 (2026-09-18): the create with
 * `repositoryMode: 'fork'` answers `400 {"message":["property repositoryMode
 * should not exist"],…}` and the fake's call log stays empty.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const WORKS_URL = `${API_BASE}/api/works`;

/** The fake GitHub's control API (`plan §8.3`) — where the fork call must show. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** A template repository, as the fork scenarios name it. */
const TEMPLATE_URL = 'https://github.com/ever-works/templates';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface RawResult {
    status: number;
    text: string;
    json: Record<string, unknown> | null;
}

async function createWorkRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<RawResult> {
    const res = await request.post(WORKS_URL, { headers: authedHeaders(token), data: body });
    const text = await res.text();
    let json: RawResult['json'] = null;
    try {
        json = JSON.parse(text) as RawResult['json'];
    } catch {
        json = null;
    }
    return { status: res.status(), text, json };
}

/** Every call the fake has served, or `null` when it is not reachable. */
async function fakeGitHubCalls(
    request: APIRequestContext,
): Promise<Array<{ method?: string; path?: string; tokenIdentity?: string }> | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/calls`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { calls?: Array<{ method?: string; path?: string }> };
        return Array.isArray(body.calls) ? body.calls : null;
    } catch {
        return null;
    }
}

test.describe('Work Template fork — the fork surface is closed before T63', () => {
    test('a create asking to fork is refused, and the fake records no fork call', async ({
        request,
    }) => {
        const callsBefore = await fakeGitHubCalls(request);
        test.skip(
            callsBefore === null,
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/calls, so the ` +
                '"no fork call" half cannot be read in this run (the PR lane starts it beside the API).',
        );

        const user = await registerUserViaAPI(request);
        const refused = await createWorkRaw(request, user.access_token, {
            name: `apw13-t15-fork ${stamp()}`,
            slug: `apw13-t15-fork-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
            description: 'APW-13 T15 template fork',
            organization: false,
            kind: 'app',
            repositoryUrl: TEMPLATE_URL,
            repositoryMode: 'fork',
            targetOwner: 'apw13-e2e-user',
        });

        expect(refused.status, `create body=${refused.text.slice(0, 300)}`).toBe(400);
        expect(
            refused.text,
            'the fork fields are not in the create contract yet, so no fork can be requested at all',
        ).toContain('repositoryMode');

        const callsAfter = await fakeGitHubCalls(request);
        expect(
            (callsAfter ?? []).length,
            'a refused create must not have reached GitHub at all',
        ).toBe((callsBefore ?? []).length);
    });
});

test.describe('Work Template fork — the success halves (T63)', () => {
    // The fork's positive contract. Both halves need a connected Git account for
    // the caller (plan §8.8): the fork call is made with the USER'S token, and
    // the fake is what records it. The marker is T14's, shared with
    // T15/T16/T30/T31.
    test.fixme('APW-13 T63: no supported GitHub connection surface', async ({
        request,
    }: {
        request: APIRequestContext;
    }) => {
        const user = await registerUserViaAPI(request);
        const callsBefore = await fakeGitHubCalls(request);

        // 1. Fork into the USER's own account: the fork lands under the
        //    caller's login and the Work records the upstream/repository
        //    coordinates. Then into an ORGANIZATION the caller can write
        //    to (`targetOwner`), which is the owner-picker half.
        for (const targetOwner of ['apw13-e2e-user', 'apw13-e2e-org']) {
            const created = await createWorkRaw(request, user.access_token, {
                name: `apw13-t15-fork-${targetOwner} ${stamp()}`,
                slug: `apw13-t15-fork-${targetOwner}-${stamp()}`
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, ''),
                description: `APW-13 T15 fork into ${targetOwner}`,
                organization: false,
                kind: 'app',
                repositoryUrl: TEMPLATE_URL,
                repositoryMode: 'fork',
                targetOwner,
            });
            expect(
                created.status,
                `fork into ${targetOwner} body=${created.text.slice(0, 300)}`,
            ).toBe(200);

            // 2. The fake recorded the FORK call, with the user's token
            //    identity on it — T15's "Done when" (`/_control/calls`
            //    records method, path and token IDENTITY, never a value).
            const calls = (await fakeGitHubCalls(request)) ?? [];
            const forkCalls = calls.filter((call) => /\/forks$/.test(call.path ?? ''));
            expect(
                forkCalls.length,
                `the fake must record the fork call for ${targetOwner}`,
            ).toBeGreaterThan((callsBefore ?? []).length);
            expect(
                forkCalls.some((call) => Boolean(call.tokenIdentity)),
                'the fork call carries a token identity — the user’s, not the estate’s',
            ).toBe(true);
        }
    });
});
