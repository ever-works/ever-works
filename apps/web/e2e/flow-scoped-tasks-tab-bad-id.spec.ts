import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * PAGE-level id handling for the two scope-filtered Tasks tabs,
 * `/ideas/[id]/tasks` and `/missions/[id]/tasks`.
 *
 * THE DEFECT THIS PINS. Both pages passed the raw `[id]` path segment
 * straight into `tasksAPI.list({ ideaId | missionId: id })`, which has no
 * internal catch. The API applies `ParseUUIDPipe` to those query params, so
 * a malformed id produced a 400 that escaped the Server Component and the
 * ROUTE answered **HTTP 500**. Observed live on app-dev.ever.works before
 * the fix:
 *
 *     GET /en/ideas/not-a-uuid/tasks     -> 500
 *     GET /en/missions/not-a-uuid/tasks  -> 500
 *
 * ...while the PARENT detail routes, handed the identical id, already
 * answered a clean 404:
 *
 *     GET /en/ideas/not-a-uuid           -> 404
 *     GET /en/missions/not-a-uuid        -> 404
 *
 * A bad id in a URL is an ordinary client error. Neither route had any
 * upstream ownership or existence check to catch it first: `ideas/[id]` has
 * no layout at all, and `missions/[id]/layout.tsx` renders the tab strip
 * without fetching anything. The fix resolves the parent Idea / Mission
 * first and calls `notFound()` when it does not resolve — the same thing
 * `/ideas/[id]` and `/missions/[id]` have always done.
 *
 * WHY THE ASSERTION IS ON HTTP STATUS. 500 and 404 both render "no tasks"
 * to the eye, so a content-only assertion passes against the bug. Only the
 * status code distinguishes them, so every case below asserts
 * `response.status()` first and treats the rendered surface as corroboration.
 * This mirrors the reasoning in `flow-admin-routes-authz.spec.ts` ("flow 9"),
 * which pinned the same 4xx→500 class on `/admin/plugins/allowlist`.
 *
 * KNOWN-GOOD CONTROLS (flow 5 and flow 6). A spec that only ever asserts 404
 * cannot tell "the fix works" from "every route in this environment 404s".
 * flow 5 pins the parent routes as the 404 reference point, and flow 6 is the
 * positive control: a REAL, caller-owned Mission and Idea must still render
 * their Tasks tab at 200 with the task visible. Without flow 6 a blanket
 * `notFound()` would pass this file.
 *
 * NON-DUPLICATION: `mission-idea-task-flow.spec.ts` already covers the happy
 * path of `/missions/:id/tasks` rendering a scoped Task. This spec does not
 * re-test the rendering contract; it pins the ID-HANDLING contract (bad,
 * unknown, and someone else's ids) plus the minimum happy-path control that
 * makes the negative assertions meaningful.
 */

/** Well-formed UUID that belongs to no record. */
const UNKNOWN_UUID = '11111111-1111-1111-1111-111111111111';

/** Ids that cannot be a UUID at all — each trips the API's ParseUUIDPipe (400). */
const MALFORMED_IDS = ['not-a-uuid', '123', 'foo-bar-baz'];

/**
 * Assert a dashboard route answered the ordinary not-found status and
 * rendered the not-found surface — never a server error.
 */
async function expectNotFoundPage(
    page: import('@playwright/test').Page,
    path: string,
    label: string,
): Promise<void> {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });

    // The regression itself. Before the fix this was 500.
    expect(response?.status(), `${label} must never answer a server error for a bad id`).not.toBe(
        500,
    );
    expect(response?.status(), `${label} answers the ordinary not-found status`).toBe(404);

    // Corroboration: the scoped-Tasks chrome must not render...
    await expect(
        page.getByRole('heading', { name: /^Tasks$/, level: 2 }),
        `${label} must not render the scoped Tasks section`,
    ).toHaveCount(0);

    // ...and the not-found surface must be what the user actually sees.
    const notFound = page
        .getByText(/page (could not be|not) found/i)
        .or(page.getByText(/^404$/))
        .or(page.getByRole('heading', { name: /not found/i }))
        .first();
    await expect(notFound, `${label} shows the not-found page`).toBeVisible({ timeout: 30_000 });
}

test.describe('Flow: scoped Tasks tabs — a malformed id in the URL (404, never 500)', () => {
    test('flow 1: /ideas/:id/tasks answers 404 for an id that cannot be a UUID — the API 400 from ParseUUIDPipe must not escape the Server Component and become an HTTP 500', async ({
        page,
    }) => {
        for (const badId of MALFORMED_IDS) {
            await expectNotFoundPage(
                page,
                `/ideas/${badId}/tasks`,
                `Idea Tasks tab with malformed id '${badId}'`,
            );
        }
    });

    test('flow 2: /missions/:id/tasks answers 404 for an id that cannot be a UUID — same 400→500 escape, and the mission layout fetches nothing so nothing upstream caught it', async ({
        page,
    }) => {
        for (const badId of MALFORMED_IDS) {
            await expectNotFoundPage(
                page,
                `/missions/${badId}/tasks`,
                `Mission Tasks tab with malformed id '${badId}'`,
            );
        }
    });
});

test.describe('Flow: scoped Tasks tabs — a well-formed id that resolves to nothing', () => {
    test('flow 3: both Tasks tabs answer 404 for a syntactically VALID uuid that matches no record — the tab must not render an empty task list, which would claim the scope exists and simply has no tasks', async ({
        page,
    }) => {
        await expectNotFoundPage(
            page,
            `/ideas/${UNKNOWN_UUID}/tasks`,
            'Idea Tasks tab with an unknown uuid',
        );
        await expectNotFoundPage(
            page,
            `/missions/${UNKNOWN_UUID}/tasks`,
            'Mission Tasks tab with an unknown uuid',
        );
    });

    test("flow 4: both Tasks tabs answer 404 for ANOTHER user's real Mission / Idea — the scope endpoints are owner-scoped, so a valid id from a foreign account resolves to nothing here and must never render that account's scope", async ({
        page,
        request,
    }) => {
        // A second, unrelated account owns the resources referenced below.
        const stranger = await registerUserViaAPI(request);
        const strangerHeaders = authedHeaders(stranger.access_token);

        const missionRes = await request.post(`${API_BASE}/api/me/missions`, {
            headers: strangerHeaders,
            data: {
                title: `Stranger Mission ${Date.now()}`,
                description: 'owned by another account',
                type: 'one-shot',
            },
        });
        expect(missionRes.ok(), 'stranger mission create').toBeTruthy();
        const strangerMission = await missionRes.json();

        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers: strangerHeaders,
            data: { description: `Stranger Idea ${Date.now()}` },
        });
        expect(ideaRes.status(), 'stranger idea create').toBe(201);
        const strangerIdea = await ideaRes.json();

        // The browser session is the SEEDED user, not the stranger.
        await expectNotFoundPage(
            page,
            `/missions/${strangerMission.id}/tasks`,
            "Mission Tasks tab with another user's mission id",
        );
        await expectNotFoundPage(
            page,
            `/ideas/${strangerIdea.id}/tasks`,
            "Idea Tasks tab with another user's idea id",
        );
    });
});

test.describe('Flow: scoped Tasks tabs — controls', () => {
    test('flow 5: CONTROL — the PARENT detail routes already answered 404 for these same malformed ids, so 404 is the reference behaviour the tabs were diverging from, not an artifact of this environment', async ({
        page,
    }) => {
        for (const badId of MALFORMED_IDS) {
            const idea = await page.goto(`/ideas/${badId}`, { waitUntil: 'domcontentloaded' });
            expect(idea?.status(), `/ideas/${badId} (parent) is the 404 reference point`).toBe(404);

            const mission = await page.goto(`/missions/${badId}`, {
                waitUntil: 'domcontentloaded',
            });
            expect(
                mission?.status(),
                `/missions/${badId} (parent) is the 404 reference point`,
            ).toBe(404);
        }
    });

    test('flow 6: POSITIVE CONTROL — a real, caller-owned Mission and Idea still render their Tasks tab at 200 with the scoped task visible; a blanket notFound() would satisfy every assertion above but fail here', async ({
        page,
        request,
    }) => {
        // Same account as the browser storageState, so what the API creates
        // here is what the page is allowed to see.
        const seeded = loadSeededTestUser();
        const { access_token } = await loginViaAPI(request, {
            email: seeded.email,
            password: seeded.password,
        });
        const headers = authedHeaders(access_token);
        const stamp = Date.now();

        const mission = await (
            await request.post(`${API_BASE}/api/me/missions`, {
                headers,
                data: {
                    title: `Bad-id control Mission ${stamp}`,
                    description: 'positive control',
                    type: 'one-shot',
                },
            })
        ).json();
        const missionTaskTitle = `Bad-id control Mission Task ${stamp}`;
        const missionTaskRes = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: missionTaskTitle, missionId: mission.id },
        });
        expect(missionTaskRes.ok(), 'mission-scoped task create').toBeTruthy();

        const ideaRes = await request.post(`${API_BASE}/api/me/work-proposals`, {
            headers,
            data: { description: `Bad-id control Idea ${stamp}` },
        });
        expect(ideaRes.status(), 'idea create').toBe(201);
        const idea = await ideaRes.json();
        const ideaTaskTitle = `Bad-id control Idea Task ${stamp}`;
        const ideaTaskRes = await request.post(`${API_BASE}/api/tasks`, {
            headers,
            data: { title: ideaTaskTitle, ideaId: idea.id },
        });
        expect(ideaTaskRes.ok(), 'idea-scoped task create').toBeTruthy();

        const missionTab = await page.goto(`/missions/${mission.id}/tasks`, {
            waitUntil: 'domcontentloaded',
        });
        expect(missionTab?.status(), 'a real Mission still renders its Tasks tab, not a 404').toBe(
            200,
        );
        await expect(page.getByText(missionTaskTitle).first()).toBeVisible({ timeout: 30_000 });

        const ideaTab = await page.goto(`/ideas/${idea.id}/tasks`, {
            waitUntil: 'domcontentloaded',
        });
        expect(ideaTab?.status(), 'a real Idea still renders its Tasks tab, not a 404').toBe(200);
        await expect(page.getByText(ideaTaskTitle).first()).toBeVisible({ timeout: 30_000 });
    });
});
