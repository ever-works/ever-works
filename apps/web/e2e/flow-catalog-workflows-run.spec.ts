import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * AW-21 — saved workflow graphs get a screen.
 *
 * Workflows are saved through the existing `/api/workflows` routes; the
 * catalogue lists them, runs one from the list, and shows its run history
 * and trace. The run control answers as soon as the run is recorded — in a
 * stack without a job runtime that run is recorded as not accepted, which the
 * row says plainly instead of showing a queue that never moves. An archived
 * workflow offers Reactivate instead of Run.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token as string;
}

async function createWorkflow(
    request: APIRequestContext,
    token: string,
    name: string,
    status: 'active' | 'draft' | 'archived',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/workflows`, {
        headers: authedHeaders(token),
        data: {
            name,
            status,
            graph: { id: 'g-e2e', entryNodeId: 'a', nodes: [{ id: 'a', kind: 'noop' }], edges: [] },
        },
    });
    expect(res.status(), `create workflow body=${await res.text()}`).toBe(201);
    return ((await res.json()) as { id: string }).id;
}

test.describe('Catalogue — saved workflows', () => {
    test('lists a saved workflow, runs it from the list, and shows its run', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `Catalog walk ${Date.now().toString(36)}`;
        const id = await createWorkflow(request, token, name, 'active');

        await page.goto('/en/catalog/workflows', { waitUntil: 'domcontentloaded' });
        const row = page.locator(`[data-testid="workflow-row"][data-workflow-id="${id}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByTestId('workflow-status')).toHaveText('Active');
        await expect(row).toContainText('1 node');

        const started = Date.now();
        await row.getByRole('button', { name: `Run ${name}` }).click();
        const feedback = row.getByTestId('workflow-row-feedback');
        await expect(feedback).toBeVisible({ timeout: 15_000 });
        await expect(feedback).toHaveText(
            /^(Queued — run [0-9a-f]{8}|Run [0-9a-f]{8} was recorded, but the job runtime did not accept it\.)$/,
        );
        // The control never waits for the graph itself.
        expect(Date.now() - started).toBeLessThan(15_000);

        const runs = await request.get(`${API_BASE}/api/workflows/${id}/runs`, {
            headers: authedHeaders(token),
        });
        expect(runs.status()).toBe(200);
        const { items } = (await runs.json()) as { items: Array<{ id: string }> };
        expect(items.length).toBe(1);

        await page.goto(`/en/catalog/workflows/${id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('workflow-run-history')).toContainText(
            items[0].id.slice(0, 8),
        );
        await expect(page.getByTestId('workflow-run-trace')).toHaveAttribute(
            'data-run-id',
            items[0].id,
        );
    });

    test("a run from another workflow is never rendered under this workflow's page", async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const suffix = Date.now().toString(36);
        const nameA = `Owner A ${suffix}`;
        const idA = await createWorkflow(request, token, nameA, 'active');
        const idB = await createWorkflow(request, token, `Owner B ${suffix}`, 'active');

        const started = await request.post(`${API_BASE}/api/workflows/${idB}/run`, {
            headers: authedHeaders(token),
        });
        expect(started.ok(), `run body=${await started.text()}`).toBe(true);
        const runs = await request.get(`${API_BASE}/api/workflows/${idB}/runs`, {
            headers: authedHeaders(token),
        });
        const { items } = (await runs.json()) as { items: Array<{ id: string }> };
        expect(items.length).toBe(1);

        await page.goto(`/en/catalog/workflows/${idA}?run=${items[0].id}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByRole('heading', { level: 1, name: nameA })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('workflow-run-mismatch')).toBeVisible();
        await expect(page.getByTestId('workflow-run-trace')).toHaveCount(0);
    });

    test('an archived workflow offers Reactivate, not Run, and running it is refused', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `Archived walk ${Date.now().toString(36)}`;
        const id = await createWorkflow(request, token, name, 'archived');

        const refused = await request.post(`${API_BASE}/api/workflows/${id}/run`, {
            headers: authedHeaders(token),
        });
        expect(refused.status()).toBe(409);

        await page.goto(`/en/catalog/workflows/${id}`, { waitUntil: 'domcontentloaded' });
        const row = page.locator(`[data-testid="workflow-row"][data-workflow-id="${id}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByTestId('workflow-status')).toHaveText('Archived');
        await expect(row.getByRole('button', { name: `Run ${name}` })).toHaveCount(0);
        await row.getByRole('button', { name: 'Reactivate' }).click();
        await expect(row.getByTestId('workflow-status')).toHaveText('Active', { timeout: 15_000 });
    });

    test('the catalogue index lists saved workflows in its Workflows section', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `Index walk ${Date.now().toString(36)}`;
        const id = await createWorkflow(request, token, name, 'draft');

        await page.goto('/en/catalog', { waitUntil: 'domcontentloaded' });
        const section = page.getByTestId('catalog-section-workflows');
        await expect(section).toBeVisible({ timeout: 30_000 });
        await expect(section.locator(`[data-workflow-id="${id}"]`)).toBeVisible();
        await expect(section.getByRole('link', { name: /See all/ })).toHaveAttribute(
            'href',
            /\/catalog\/workflows$/,
        );
    });
});
