import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * AW-21 — readiness and preflight for a playbook that needs a connection.
 *
 * `market-watch-brief` requires the `search` capability. Whether this stack
 * has a search plugin enabled for the caller is deployment state, so the
 * spec asserts the CONTRACT rather than one outcome: readiness reads
 * `needs_connection` exactly when no enabled plugin satisfies `search`, the
 * page shows the same state with a Connect link when it is missing, and
 * preflight — however often it runs — creates nothing.
 */

interface Connection {
    capability: string;
    required: boolean;
    satisfiedBy: { pluginId: string; name: string } | null;
}

async function countRows(request: APIRequestContext, token: string, path: string): Promise<number> {
    const res = await request.get(`${API_BASE}${path}`, { headers: authedHeaders(token) });
    expect(res.status(), `${path} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    if (Array.isArray(body)) return body.length;
    if (typeof body?.meta?.total === 'number') return body.meta.total;
    if (typeof body?.total === 'number') return body.total;
    return (body?.data ?? body?.items ?? []).length;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token as string;
}

test.describe('Playbook readiness and preflight', () => {
    test('readiness names the missing capability exactly when nothing provides it', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/catalog/playbooks/market-watch-brief/preflight`,
            {
                headers: authedHeaders(user.access_token),
                data: { instanceName: 'Market watch for e2e' },
            },
        );
        expect(res.status(), await res.text()).toBe(200);
        const report = await res.json();

        const search = (report.connections as Connection[]).find((c) => c.capability === 'search');
        expect(search?.required).toBe(true);
        if (search?.satisfiedBy) {
            expect(report.missingRequired).not.toContain('search');
            expect(report.state).not.toBe('needs_connection');
        } else {
            expect(report.missingRequired).toEqual(['search']);
            expect(report.state).toBe('needs_connection');
        }

        expect(report.plan.instanceName).toBe('Market watch for e2e');
        expect(report.plan.planHash).toMatch(/^[0-9a-f]{64}$/);
        expect(report.plan.items.map((item: { type: string }) => item.type)).toEqual(
            expect.arrayContaining(['agent', 'task_template', 'guardrails']),
        );
    });

    test('preflight creates nothing, however often it runs', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const before = {
            agents: await countRows(request, token, '/api/agents'),
            workflows: await countRows(request, token, '/api/workflows'),
        };

        for (let i = 0; i < 20; i++) {
            const res = await request.post(
                `${API_BASE}/api/catalog/playbooks/weekly-operations-report/preflight`,
                {
                    headers: authedHeaders(token),
                    data: {},
                },
            );
            expect(res.status()).toBe(200);
        }

        expect(await countRows(request, token, '/api/agents')).toBe(before.agents);
        expect(await countRows(request, token, '/api/workflows')).toBe(before.workflows);
    });

    test('rejects a malformed preflight body', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(
            `${API_BASE}/api/catalog/playbooks/market-watch-brief/preflight`,
            {
                headers: authedHeaders(user.access_token),
                data: { workId: 'not-a-uuid' },
            },
        );
        expect(res.status()).toBe(400);
    });

    test('the detail page shows the same readiness and links to Plugins when search is missing', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const api = await request.get(`${API_BASE}/api/catalog/playbooks/market-watch-brief`, {
            headers: authedHeaders(token),
        });
        expect(api.status()).toBe(200);
        const { readiness } = await api.json();

        await page.goto('/en/catalog/playbooks/market-watch-brief', {
            waitUntil: 'domcontentloaded',
        });
        const panel = page.getByTestId('playbook-readiness');
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(panel).toHaveAttribute('data-state', readiness.state);

        const searchRow = panel.locator(
            '[data-testid="playbook-connection"][data-capability="search"]',
        );
        await expect(searchRow).toBeVisible();
        if (readiness.missingRequired.includes('search')) {
            await expect(searchRow).toHaveAttribute('data-satisfied', 'false');
            await expect(panel).toContainText('Not ready — 1 required connection missing');
            const connect = searchRow.getByRole('link', { name: /Connect/ });
            await expect(connect).toHaveAttribute('href', /\/plugins\?q=/);
        } else {
            await expect(searchRow).toHaveAttribute('data-satisfied', 'true');
        }
        await expect(page.getByTestId('step-asks-you').first()).toBeVisible();
    });
});
