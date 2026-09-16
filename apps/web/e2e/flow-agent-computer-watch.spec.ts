import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import { loginViaUI } from './helpers/auth';

/**
 * Agent computers — watching an Agent's computer, walked through the UI.
 *
 * Entry (the Agent page's "Watch computer" and the Computer tab) → the empty
 * state for an account with no computers → the "live view is switched off"
 * state and the picker's reason for a machine that never ran `--attend` →
 * the live surface (identity strip, status sentence, watermark) for an
 * attended machine, driven to LIVE by publishing a frame as that machine.
 *
 * Every test runs as a FRESH account so "no computers" is a true statement,
 * and machines are enrolled through the public protocol — no daemon needed.
 * Locators prefer test ids and role+name over long `*ByRole` chains.
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

async function enrollNode(
    request: APIRequestContext,
    user: RegisteredUser,
    capabilities: string[],
): Promise<{ nodeId: string; secret: string; name: string }> {
    const name = `Computer ${uniq()}`;
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(user.access_token),
        data: { name, kind: 'desktop-node' },
    });
    expect(minted.status()).toBe(201);
    const { token } = await minted.json();
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: { token, platform: 'linux/x64', version: '1.0.0', capabilities },
    });
    expect(enrolled.status()).toBe(201);
    const body = await enrolled.json();
    return { nodeId: body.nodeId, secret: body.secret, name };
}

test.describe('watch an Agent’s computer', () => {
    test('the Agent page offers Watch computer, and an account with no computers gets the way to add one', async ({
        browser,
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `Ops ${uniq()}`,
        });
        const context = await freshContext(browser);
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: user.email, password: user.password });
            await page.goto(`/en/agents/${agent.id}`, { waitUntil: 'domcontentloaded' });

            const watch = page
                .getByTestId('agent-hero-actions')
                .getByRole('link', { name: 'Watch computer' });
            await expect(watch).toBeVisible({ timeout: 15_000 });
            await expect(page.getByRole('link', { name: 'Computer', exact: true })).toBeVisible();

            await watch.click();
            await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/computer`));
            await expect(page.getByTestId('computer-empty')).toContainText(
                `${agent.name} does not have a computer yet`,
            );
            await expect(
                page.getByTestId('computer-empty').getByRole('link', { name: 'Add a computer' }),
            ).toHaveAttribute('href', /\/settings\/fleet/);
        } finally {
            await context.close();
        }
    });

    test('a machine without live view switched on says so, with the command, and the picker gives the reason', async ({
        browser,
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `Ops ${uniq()}`,
        });
        const node = await enrollNode(request, user, ['terminal', 'workspace', 'browser']);
        const context = await freshContext(browser);
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: user.email, password: user.password });
            await page.goto(`/en/agents/${agent.id}/computer`, { waitUntil: 'domcontentloaded' });

            const state = page.getByTestId('computer-not-attended');
            await expect(state).toBeVisible({ timeout: 15_000 });
            await expect(state).toContainText(`Live view is switched off on ${node.name}`);
            await expect(page.getByTestId('computer-attend-command')).toHaveText(
                'ever-works-node start --attend',
            );

            await page.getByTestId('computer-node-picker-trigger').click();
            const picker = page.getByTestId('computer-node-picker');
            await expect(picker).toContainText(
                `Watching a computer does not change where ${agent.name}'s work runs.`,
            );
            await expect(page.getByTestId(`computer-node-option-${node.nodeId}`)).toContainText(
                'Live view is switched off',
            );
        } finally {
            await context.close();
        }
    });

    test('an attended machine shows the live surface: strip, status sentence and watermark, then LIVE', async ({
        browser,
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `Ops ${uniq()}`,
        });
        const node = await enrollNode(request, user, [
            'terminal',
            'workspace',
            'browser',
            'attended',
            'screen',
        ]);

        // Probe the runtime first: without one the page shows "not available" instead.
        const probe = await request.post(`${API_BASE}/api/agents/${agent.id}/computer/sessions`, {
            headers: authedHeaders(user.access_token),
            data: { nodeId: node.nodeId, channels: ['screen'] },
        });
        test.skip(probe.status() === 503, 'no fleet runtime is wired on this install');
        if (probe.status() === 202) {
            const { sessionId } = await probe.json();
            await request.delete(
                `${API_BASE}/api/agents/${agent.id}/computer/sessions/${sessionId}`,
                {
                    headers: authedHeaders(user.access_token),
                },
            );
        }

        const context = await freshContext(browser);
        const page = await context.newPage();
        try {
            await loginViaUI(page, { email: user.email, password: user.password });
            await page.goto(`/en/agents/${agent.id}/computer?node=${node.nodeId}`, {
                waitUntil: 'domcontentloaded',
            });

            const surface = page.getByTestId('computer-surface');
            await expect(surface).toBeVisible({ timeout: 20_000 });
            await expect(page.getByTestId('computer-identity-strip')).toContainText(agent.name);
            await expect(page.getByTestId('computer-status-line')).toHaveText(
                `Watching — ${agent.name} keeps working.`,
            );
            await expect(page.getByTestId('computer-watermark')).toHaveText(
                `EVER WORKS · LIVE VIEW · ${agent.name} @ ${node.name}`,
            );
            await expect(page.getByTestId('computer-brief')).toContainText(
                'Idle — no task in flight',
            );
            await expect(page.getByTestId('computer-live-badge')).toHaveText('CONNECTING');

            // Play the machine: claim the view on the live-view lane and publish a picture.
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

            await expect
                .poll(
                    async () => {
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
                        return res.status();
                    },
                    { timeout: 10_000 },
                )
                .toBe(202);
            await expect(page.getByTestId('computer-live-badge')).toHaveText('LIVE', {
                timeout: 15_000,
            });
        } finally {
            await context.close();
        }
    });
});
