import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI } from './helpers/api';
import { createTaskViaAPI } from './helpers/agents-tasks';
import { createTriggerViaAPI } from './helpers/triggers';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { clickUntil } from './helpers/nav';

/**
 * Schedules list — `/activity?view=schedules`, the list surface.
 *
 * Seeds sources through the API as the storageState user (personal scope, the
 * same scope the browser reads in) and asserts the REAL surface:
 *
 *   • `/schedules` (the retired page) still resolves — it redirects here with
 *     the filter set — and the sidebar has ONE Activity entry, not two
 *   • rows from several sources render with source label, cadence and health
 *   • a cadence that can never fire (30 February) is flagged NEVER RUNS, the
 *     banner counts it, and Review shows the proposed before/after
 *   • filters narrow the list and survive a reload through the URL
 *   • the paged API contract (limit 50, cursor, 400 on unknown params)
 *   • run-now on a recurring task leaves its next scheduled fire unchanged
 *
 * Every row is addressed by its synthetic test id, never by global counts.
 */

const SCHEDULES_URL = '/en/schedules';
const SCHEDULES_VIEW_URL = '/en/activity?view=schedules';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

async function makeRecurring(
    request: APIRequestContext,
    token: string,
    taskId: string,
    data: Record<string, unknown>,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        data,
    });
    expect(res.status(), `recurring body=${await res.text().catch(() => '')}`).toBe(200);
}

function rowTestId(sourceType: string, ownerId: string): string {
    return `schedule-workspace-row-${sourceType}:${ownerId}`;
}

test.describe('Schedules workspace — list', () => {
    test('the Schedules page is retired into the Activity view, and the sidebar has one entry', async ({
        page,
    }) => {
        // The sidebar no longer carries a Schedules item: the list is a view of
        // Activity, and the retired path still highlights that entry.
        await page.goto('/en/tasks', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('aside a[href$="/schedules"]')).toHaveCount(0);
        const activityLink = page.locator('aside a[href$="/activity"]').first();
        await expect(activityLink).toBeVisible({ timeout: 30_000 });

        // A bookmark on the old page lands on the list, and gains the view param.
        await page.goto(SCHEDULES_URL, { waitUntil: 'domcontentloaded' });
        await expect
            .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
            .toMatch(/^\/(en\/)?activity$/);
        expect(new URL(page.url()).searchParams.get('view')).toBe('schedules');
        await expect(page.getByTestId('schedules-workspace')).toBeVisible({ timeout: 30_000 });

        // The deep link addresses the same list directly.
        await page.goto(SCHEDULES_VIEW_URL, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('schedules-workspace')).toBeVisible({ timeout: 30_000 });
    });

    test('the retired /schedules path forwards the filter set it was given', async ({ page }) => {
        // The FILTERS are the thing worth preserving: a shared link to a
        // narrowed list has to land on that narrowed list, not on a default one.
        await page.goto('/en/schedules?status=paused&active=1&q=zzz', {
            waitUntil: 'domcontentloaded',
        });
        await expect
            .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
            .toMatch(/^\/(en\/)?activity$/);
        const params = new URL(page.url()).searchParams;
        expect(params.get('view')).toBe('schedules');
        expect(params.get('status')).toBe('paused');
        expect(params.get('active')).toBe('1');
        expect(params.get('q')).toBe('zzz');
    });

    test('renders several sources with their labels, cadence and health', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTaskViaAPI(request, token, { title: `WS Daily ${stamp()}` });
        await makeRecurring(request, token, task.id, { recurrenceCron: '0 7 * * *' });
        const { trigger } = await createTriggerViaAPI(request, token, {
            name: `WS Hook ${stamp()}`,
            kind: 'webhook',
        });

        await page.goto(SCHEDULES_URL, { waitUntil: 'domcontentloaded' });
        const taskRow = page.getByTestId(rowTestId('recurring_task', task.id));
        await expect(taskRow).toBeVisible({ timeout: 30_000 });
        await expect(taskRow.getByText('Recurring task')).toBeVisible();
        await expect(taskRow.getByText('Every day at 07:00')).toBeVisible();
        await expect(taskRow.getByTestId('schedule-health-badge')).toBeVisible();

        const triggerRow = page.getByTestId(rowTestId('inbound_trigger', trigger.id));
        await expect(triggerRow).toBeVisible();
        await expect(triggerRow.getByText('Inbound trigger')).toBeVisible();
        await expect(triggerRow.getByText('On event')).toBeVisible();
    });

    test('flags a cadence that can never fire and previews the repair', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTaskViaAPI(request, token, { title: `WS Feb30 ${stamp()}` });
        // Day 30 of February is accepted by the cron grammar and never fires.
        const res = await request.post(`${API_BASE}/api/tasks/${task.id}/recurring`, {
            headers: authedHeaders(token),
            data: { recurrenceCron: '0 18 30 2 *' },
        });
        test.skip(
            res.status() !== 200,
            'this build refuses the impossible cadence at write time — nothing to flag',
        );

        const health = await request.get(`${API_BASE}/api/schedules/health`, {
            headers: authedHeaders(token),
        });
        expect(health.status()).toBe(200);
        const summary = await health.json();
        const flag = summary.flagged.find(
            (row: { id: string }) => row.id === `recurring_task:${task.id}`,
        );
        expect(flag).toMatchObject({ reason: 'impossible-date', after: '0 18 28 2 *' });

        await page.goto(SCHEDULES_URL, { waitUntil: 'domcontentloaded' });
        const row = page.getByTestId(rowTestId('recurring_task', task.id));
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByTestId('schedule-health-badge')).toHaveAttribute(
            'data-health',
            'never-runs',
        );
        const banner = page.getByTestId('schedules-health-banner');
        await expect(banner).toBeVisible();
        await clickUntil(banner.getByTestId('schedules-health-review'), async () =>
            page.getByTestId('schedules-health-review-list').isVisible(),
        );
        await expect(
            page
                .getByTestId(`schedules-health-flag-recurring_task:${task.id}`)
                .getByText('0 18 28 2 *'),
        ).toBeVisible();
    });

    test('filters narrow the list and survive a reload through the URL', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTaskViaAPI(request, token, { title: `WS Filter ${stamp()}` });
        await makeRecurring(request, token, task.id, { recurrenceRule: 'FREQ=DAILY;INTERVAL=1' });
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `WS Work ${stamp()}`,
            slug: `ws-work-${stamp()}`,
        });

        await page.goto(`${SCHEDULES_URL}?source=recurring_task`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByTestId(rowTestId('recurring_task', task.id))).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId(rowTestId('data_sync', workId))).toHaveCount(0);
        await expect(page.getByTestId('schedules-filter-source')).toHaveValue('recurring_task');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('schedules-filter-source')).toHaveValue('recurring_task', {
            timeout: 30_000,
        });
        await expect(page.getByTestId(rowTestId('data_sync', workId))).toHaveCount(0);
    });

    test('the paged API pages at 50, carries a cursor and rejects unknown parameters', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const first = await request.get(`${API_BASE}/api/schedules/page?limit=50`, {
            headers: authedHeaders(token),
        });
        expect(first.status()).toBe(200);
        const body = await first.json();
        expect(body.items.length).toBeLessThanOrEqual(50);
        expect(typeof body.total).toBe('number');
        expect(body).toHaveProperty('nextCursor');
        expect(Array.isArray(body.degradedSources)).toBe(true);

        for (const query of ['limit=51', 'userId=someone', 'sort=nextRunAt']) {
            const bad = await request.get(`${API_BASE}/api/schedules/page?${query}`, {
                headers: authedHeaders(token),
            });
            expect(bad.status(), query).toBe(400);
        }

        // The flat list keeps its bare-array contract.
        const flat = await request.get(`${API_BASE}/api/schedules`, {
            headers: authedHeaders(token),
        });
        expect(Array.isArray(await flat.json())).toBe(true);
    });

    test('run-now on a recurring task leaves the next scheduled fire unchanged', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTaskViaAPI(request, token, { title: `WS RunNow ${stamp()}` });
        await makeRecurring(request, token, task.id, { recurrenceCron: '0 7 * * *' });

        const before = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(token),
        });
        const nextBefore = (await before.json()).nextOccurrenceAt;

        const run = await request.post(
            `${API_BASE}/api/schedules/${encodeURIComponent(`recurring_task:${task.id}`)}/run-now`,
            { headers: authedHeaders(token) },
        );
        // No agent is assigned, so the refusal is stated — and nothing moves.
        expect([202, 409, 503]).toContain(run.status());
        if (run.status() === 409) {
            expect((await run.json()).code).toBe('SCHEDULE_NO_AGENT');
        }

        const after = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
            headers: authedHeaders(token),
        });
        expect((await after.json()).nextOccurrenceAt).toBe(nextBefore);

        const foreign = await request.post(
            `${API_BASE}/api/schedules/${encodeURIComponent(
                'recurring_task:00000000-0000-4000-8000-000000000000',
            )}/run-now`,
            { headers: authedHeaders(token) },
        );
        expect(foreign.status()).toBe(404);
    });
});
