import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import { loginViaUI } from './helpers/auth';

/**
 * Agent computers — taking control of an Agent's computer.
 *
 * ── Owner routes (apps/api/src/computer/computer.controller.ts) ──────
 *   GET    /api/agents/:id/computer/sessions/:sessionId/control            → 200 control state
 *   POST   /api/agents/:id/computer/sessions/:sessionId/control            → 200 | 409 held (names holder)
 *   POST   …/control { request: true }                                     → 200 with the pending request
 *   POST   …/control/handover { requestId, decision }                      → 200, control moves
 *   DELETE …/control                                                       → 204
 *   POST   …/attach-token?role=controller                                  → driver only for the holder
 *
 * Every test runs as a FRESH account, machines are enrolled through the
 * public protocol, and this spec plays the machine's half itself (lease the
 * view, publish a picture) — no daemon needed. An install with no fleet
 * runtime answers the open with 503 and the spec skips rather than pretend.
 */

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000').origin;

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function freshContext(browser: Browser) {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addCookies([{ name: 'sidebar-collapsed', value: '0', url: ORIGIN }]);
    return context;
}

/**
 * A FRESH account whose first-run onboarding wizard is already dismissed.
 *
 * A brand-new account has zero Works, so the dashboard auto-opens
 * `EverWorksOnboardingWizard` (`layout-client.tsx`: `shouldAutoOpenOnboarding =
 * onboardingTotalWorks === 0 && !isOnboardingDismissed && !isOnboardingCompleted`)
 * and its `fixed inset-0` backdrop swallows every click on this page. Dismissed
 * server-side BEFORE the UI login so the post-login server render already reads
 * `dismissedAt`. Mirrors `flow-fleet-runner-pill.spec.ts`; the 200 is asserted so
 * a dismissal that stops working names itself here.
 */
async function registerUserWithOnboardingDismissed(
    request: APIRequestContext,
): Promise<RegisteredUser> {
    const u = await registerUserViaAPI(request);
    const dismissed = await request.post(`${API_BASE}/api/onboarding/dismiss`, {
        headers: authedHeaders(u.access_token),
    });
    expect(dismissed.status(), `dismiss body=${await dismissed.text().catch(() => '')}`).toBe(200);
    return u;
}

/**
 * Bound for every click on the computer page. `playwright.config.ts` sets no
 * `actionTimeout`, so an unbounded click on a covered element retries to the
 * 150s test timeout and the `finally { context.close() }` error then replaces
 * its call log. A bounded click fails on its own and names the interceptor.
 */
const CLICK_TIMEOUT = 15_000;

async function enrollAttendedNode(
    request: APIRequestContext,
    user: RegisteredUser,
): Promise<{ nodeId: string; secret: string; name: string }> {
    const name = `Computer ${uniq()}`;
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(user.access_token),
        data: { name, kind: 'desktop-node' },
    });
    expect(minted.status()).toBe(201);
    const { token } = await minted.json();
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: {
            token,
            platform: 'linux/x64',
            version: '1.0.0',
            capabilities: ['terminal', 'workspace', 'browser', 'attended', 'screen'],
        },
    });
    expect(enrolled.status()).toBe(201);
    const body = await enrolled.json();
    return { nodeId: body.nodeId, secret: body.secret, name };
}

/** Claim waiting views as the machine and publish one picture into `sessionId`. */
async function makeLive(
    request: APIRequestContext,
    node: { nodeId: string; secret: string },
    sessionId: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                await request.post(`${API_BASE}/api/fleet/jobs/lease`, {
                    data: {
                        nodeId: node.nodeId,
                        secret: node.secret,
                        max: 2,
                        kinds: ['computer-session'],
                    },
                });
                const res = await request.post(
                    `${API_BASE}/api/internal/computer/${sessionId}/frames`,
                    {
                        data: {
                            nodeId: node.nodeId,
                            secret: node.secret,
                            frames: [
                                {
                                    kind: 'frame',
                                    seq: Date.now(),
                                    keyframe: true,
                                    width: 2,
                                    height: 2,
                                    mime: 'image/jpeg',
                                    data: 'QUJD',
                                },
                            ],
                        },
                    },
                );
                // Assert what the publish DID, not merely its status: an ended
                // session ALSO answers 202 with every frame dropped
                // (`computer-internal.controller.ts` endedAnswer), so a bare
                // `.toBe(202)` cannot tell a relayed frame from a discarded one.
                // Note what this does and does not prove: `accepted` counts
                // frames the relay took (`relay.publish` returned true), NOT
                // viewers reached — it rules out the ended-session explanation
                // only. What proves a frame reached the browser is the caller's
                // own LIVE badge assertion.
                return res.status() === 202
                    ? await res.json()
                    : { status: res.status(), body: await res.text() };
            },
            { timeout: 15_000 },
        )
        .toMatchObject({ accepted: 1, ended: false });
}

test.describe('take over an Agent’s computer — contract', () => {
    test('one holder at a time: take, refuse a second view naming the holder, request, hand over, give back', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `Ops ${uniq()}`,
        });
        const node = await enrollAttendedNode(request, user);
        const base = `${API_BASE}/api/agents/${agent.id}/computer`;
        const headers = authedHeaders(user.access_token);

        const openView = async () =>
            request.post(`${base}/sessions`, {
                headers,
                data: { nodeId: node.nodeId, channels: ['screen'] },
            });
        const first = await openView();
        test.skip(first.status() === 503, 'no fleet runtime is wired on this install');
        expect(first.status()).toBe(202);
        const viewA = (await first.json()).sessionId as string;
        await makeLive(request, node, viewA);

        const control = (view: string) => `${base}/sessions/${view}/control`;

        const initial = await request.get(control(viewA), { headers });
        expect(initial.status()).toBe(200);
        expect(await initial.json()).toMatchObject({
            mode: 'watching',
            canControl: true,
            policy: 'owner',
            holder: null,
        });

        const taken = await request.post(control(viewA), { headers, data: {} });
        expect(taken.status()).toBe(200);
        expect(await taken.json()).toMatchObject({
            mode: 'controlling',
            holder: { sessionId: viewA, thisView: true },
        });

        // The holder's view is minted a driving token; nobody else's is.
        const drivingToken = await request.post(
            `${base}/sessions/${viewA}/attach-token?role=controller`,
            { headers },
        );
        expect((await drivingToken.json()).role).toBe('driver');

        const second = await openView();
        expect(second.status()).toBe(202);
        const viewB = (await second.json()).sessionId as string;
        await makeLive(request, node, viewB);

        const refused = await request.post(control(viewB), { headers, data: {} });
        expect(refused.status()).toBe(409);
        expect(await refused.json()).toMatchObject({
            reason: 'held',
            holder: { sessionId: viewA },
        });
        const watchingToken = await request.post(
            `${base}/sessions/${viewB}/attach-token?role=controller`,
            { headers },
        );
        expect((await watchingToken.json()).role).toBe('viewer');

        const asked = await request.post(control(viewB), { headers, data: { request: true } });
        expect(asked.status()).toBe(200);
        expect(await asked.json()).toMatchObject({ request: { requestId: viewB } });

        const holderSees = await request.get(control(viewA), { headers });
        expect(await holderSees.json()).toMatchObject({ request: { requestId: viewB } });

        const handedOver = await request.post(`${control(viewA)}/handover`, {
            headers,
            data: { requestId: viewB, decision: 'hand-over' },
        });
        expect(handedOver.status()).toBe(200);
        expect(await handedOver.json()).toMatchObject({
            mode: 'watching',
            holder: { sessionId: viewB },
            lastRelease: { reason: 'handed-over' },
        });

        const givenBack = await request.delete(control(viewB), { headers });
        expect(givenBack.status()).toBe(204);
        const after = await request.get(control(viewB), { headers });
        expect(await after.json()).toMatchObject({
            holder: null,
            lastRelease: { reason: 'given-back' },
        });

        const unknown = await request.get(control('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
            headers,
        });
        expect(unknown.status()).toBe(404);

        for (const view of [viewA, viewB]) {
            await request.delete(`${base}/sessions/${view}`, { headers });
        }
    });
});

test.describe('take over an Agent’s computer — the page', () => {
    test('Take over puts the page in control, and Give back control returns it to watching', async ({
        browser,
        request,
    }) => {
        const user = await registerUserWithOnboardingDismissed(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `Ops ${uniq()}`,
        });
        const node = await enrollAttendedNode(request, user);

        const probe = await request.post(`${API_BASE}/api/agents/${agent.id}/computer/sessions`, {
            headers: authedHeaders(user.access_token),
            data: { nodeId: node.nodeId, channels: ['screen'] },
        });
        test.skip(probe.status() === 503, 'no fleet runtime is wired on this install');
        if (probe.status() === 202) {
            const { sessionId } = await probe.json();
            await request.delete(
                `${API_BASE}/api/agents/${agent.id}/computer/sessions/${sessionId}`,
                { headers: authedHeaders(user.access_token) },
            );
        }

        const context = await freshContext(browser);
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: user.email, password: user.password });
            await page.goto(`/en/agents/${agent.id}/computer?node=${node.nodeId}`, {
                waitUntil: 'domcontentloaded',
            });
            await expect(page.getByTestId('computer-surface')).toBeVisible({ timeout: 20_000 });

            // Play the machine: find the page's view, claim it and publish a picture.
            let sessionId: string | null = null;
            await expect
                .poll(
                    async () => {
                        const lease = await request.post(`${API_BASE}/api/fleet/jobs/lease`, {
                            data: {
                                nodeId: node.nodeId,
                                secret: node.secret,
                                max: 1,
                                kinds: ['computer-session'],
                            },
                        });
                        const jobs = (await lease.json()).jobs as Array<{
                            payload: { sessionId?: string };
                        }>;
                        sessionId = jobs[0]?.payload?.sessionId ?? sessionId;
                        return sessionId;
                    },
                    { timeout: 15_000 },
                )
                .not.toBeNull();
            await makeLive(request, node, sessionId as unknown as string);
            await expect(page.getByTestId('computer-live-badge')).toHaveText('LIVE', {
                timeout: 15_000,
            });

            const takeOver = page.getByTestId('computer-take-over');
            await expect(takeOver).toBeEnabled({ timeout: 15_000 });
            await takeOver.click({ timeout: CLICK_TIMEOUT });

            await expect(page.getByTestId('computer-mode-sentence')).toHaveText(
                `You have control — ${agent.name}'s input is paused.`,
                { timeout: 15_000 },
            );
            await expect(page.getByTestId('computer-you-badge')).toBeVisible();
            await expect(page.getByTestId('computer-stage')).toHaveAttribute(
                'data-controlling',
                'true',
            );

            await page.getByTestId('computer-give-back').click({ timeout: CLICK_TIMEOUT });
            await expect(page.getByTestId('computer-mode-sentence')).toHaveText(
                `Watching — ${agent.name} keeps working.`,
                { timeout: 15_000 },
            );
            await expect(page.getByTestId('computer-you-badge')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});
